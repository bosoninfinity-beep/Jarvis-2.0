#!/usr/bin/env python3
"""
VNC Control - Send mouse/keyboard events to a VNC server.
Uses RFB protocol with VNCAuth (type 2).

Usage:
  echo "PASSWORD" | python3 vnc-control.py HOST PORT ACTION [PARAMS...]

Actions:
  screenshot [OUTPUT_FILE]   - Capture framebuffer (default: base64 to stdout)
  click X Y                  - Left click at (X, Y)
  doubleclick X Y            - Double left click
  rightclick X Y             - Right click
  type TEXT                  - Type text
  key KEYNAME                - Press a key (e.g., Return, Tab, Escape)
  keycombo MOD+KEY           - Key combo (e.g., cmd+c, ctrl+a)
  scroll DIRECTION [AMOUNT]  - Scroll up/down/left/right
  move X Y                   - Move mouse to (X, Y)
  drag X1 Y1 X2 Y2           - Drag from (X1,Y1) to (X2,Y2)
  screensize                 - Get screen dimensions
"""

import sys
import socket
import struct
import time
import io
import base64

try:
    from PIL import Image
except ImportError:
    Image = None

# Key symbol mappings (X11 keysyms used by VNC/RFB)
KEYSYM_MAP = {
    'return': 0xff0d, 'enter': 0xff0d,
    'tab': 0xff09,
    'escape': 0xff1b, 'esc': 0xff1b,
    'backspace': 0xff08, 'delete': 0xffff,
    'space': 0x0020,
    'up': 0xff52, 'down': 0xff54, 'left': 0xff51, 'right': 0xff53,
    'home': 0xff50, 'end': 0xff57,
    'pageup': 0xff55, 'pagedown': 0xff56,
    'f1': 0xffbe, 'f2': 0xffbf, 'f3': 0xffc0, 'f4': 0xffc1,
    'f5': 0xffc2, 'f6': 0xffc3, 'f7': 0xffc4, 'f8': 0xffc5,
    'f9': 0xffc6, 'f10': 0xffc7, 'f11': 0xffc8, 'f12': 0xffc9,
    # Modifiers
    'shift': 0xffe1, 'shift_l': 0xffe1, 'shift_r': 0xffe2,
    'ctrl': 0xffe3, 'control': 0xffe3, 'ctrl_l': 0xffe3, 'ctrl_r': 0xffe4,
    'alt': 0xffe9, 'option': 0xffe9, 'alt_l': 0xffe9, 'alt_r': 0xffea,
    'cmd': 0xffe7, 'command': 0xffe7, 'meta': 0xffe7, 'super': 0xffeb,
    'super_l': 0xffeb, 'super_r': 0xffec,
    # Special
    'insert': 0xff63,
    'capslock': 0xffe5,
    'numlock': 0xff7f,
}


def vnc_des_encrypt(key_bytes, challenge):
    try:
        from Crypto.Cipher import DES
    except ImportError:
        from Cryptodome.Cipher import DES
    reversed_key = bytes(int('{:08b}'.format(b)[::-1], 2) for b in key_bytes)
    cipher = DES.new(reversed_key, DES.MODE_ECB)
    return cipher.encrypt(challenge)


class VNCConnection:
    def __init__(self, host, port, password):
        self.host = host
        self.port = port
        self.password = password
        self.sock = None
        self.width = 0
        self.height = 0
        self.name = ''

    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect((self.host, self.port))

        # Protocol version
        server_version = self.sock.recv(12)
        self.sock.send(b'RFB 003.008\n')

        # Security types
        num_types = struct.unpack('B', self.sock.recv(1))[0]
        if num_types == 0:
            err_len = struct.unpack('>I', self.sock.recv(4))[0]
            err_msg = self.sock.recv(err_len).decode('utf-8', errors='replace')
            raise Exception(f"VNC error: {err_msg}")

        security_types = list(self.sock.recv(num_types))

        if 2 in security_types:
            self.sock.send(struct.pack('B', 2))
            challenge = self.sock.recv(16)
            key = (self.password.encode('utf-8') + b'\x00' * 8)[:8]
            response = vnc_des_encrypt(key, challenge[:8]) + vnc_des_encrypt(key, challenge[8:16])
            self.sock.send(response)
            auth_result = struct.unpack('>I', self.sock.recv(4))[0]
            if auth_result != 0:
                raise Exception("VNC authentication failed")
        elif 1 in security_types:
            self.sock.send(struct.pack('B', 1))
        else:
            raise Exception(f"No supported security type: {security_types}")

        # Client init
        self.sock.send(struct.pack('B', 1))

        # Server init
        server_init = self.sock.recv(24)
        self.width, self.height = struct.unpack('>HH', server_init[:4])
        name_len = struct.unpack('>I', server_init[20:24])[0]
        self.name = self.sock.recv(name_len).decode('utf-8', errors='replace')

    def close(self):
        if self.sock:
            self.sock.close()

    def recv_exact(self, n):
        data = b''
        while len(data) < n:
            chunk = self.sock.recv(min(n - len(data), 65536))
            if not chunk:
                raise Exception("Connection closed")
            data += chunk
        return data

    def send_pointer_event(self, x, y, button_mask=0):
        """RFB PointerEvent: msg_type=5, button_mask, x, y"""
        msg = struct.pack('>BBHH', 5, button_mask, x, y)
        self.sock.send(msg)

    def send_key_event(self, key, down=True):
        """RFB KeyEvent: msg_type=4, down_flag, padding, key"""
        msg = struct.pack('>BBxxI', 4, 1 if down else 0, key)
        self.sock.send(msg)

    def click(self, x, y, button=1):
        """Click at position. button: 1=left, 2=middle, 4=right"""
        # Move to position
        self.send_pointer_event(x, y, 0)
        time.sleep(0.02)
        # Press
        self.send_pointer_event(x, y, button)
        time.sleep(0.05)
        # Release
        self.send_pointer_event(x, y, 0)

    def double_click(self, x, y):
        self.click(x, y, 1)
        time.sleep(0.1)
        self.click(x, y, 1)

    def right_click(self, x, y):
        self.click(x, y, 4)

    def move(self, x, y):
        self.send_pointer_event(x, y, 0)

    def drag(self, x1, y1, x2, y2, steps=20):
        self.send_pointer_event(x1, y1, 0)
        time.sleep(0.02)
        self.send_pointer_event(x1, y1, 1)  # press
        time.sleep(0.05)
        for i in range(1, steps + 1):
            t = i / steps
            x = int(x1 + (x2 - x1) * t)
            y = int(y1 + (y2 - y1) * t)
            self.send_pointer_event(x, y, 1)
            time.sleep(0.02)
        self.send_pointer_event(x2, y2, 0)  # release

    def type_text(self, text):
        for ch in text:
            keysym = ord(ch)
            self.send_key_event(keysym, True)
            self.send_key_event(keysym, False)
            time.sleep(0.02)

    def press_key(self, key_name):
        keysym = KEYSYM_MAP.get(key_name.lower())
        if keysym is None:
            if len(key_name) == 1:
                keysym = ord(key_name)
            else:
                raise ValueError(f"Unknown key: {key_name}")
        self.send_key_event(keysym, True)
        time.sleep(0.05)
        self.send_key_event(keysym, False)

    def key_combo(self, combo):
        """Press a key combo like 'cmd+c', 'ctrl+shift+a'"""
        parts = combo.lower().split('+')
        keys = []
        for part in parts:
            part = part.strip()
            keysym = KEYSYM_MAP.get(part)
            if keysym is None:
                if len(part) == 1:
                    keysym = ord(part)
                else:
                    raise ValueError(f"Unknown key in combo: {part}")
            keys.append(keysym)

        # Press all keys down
        for k in keys:
            self.send_key_event(k, True)
            time.sleep(0.02)
        time.sleep(0.05)
        # Release in reverse order
        for k in reversed(keys):
            self.send_key_event(k, False)
            time.sleep(0.02)

    def scroll(self, direction, amount=3, x=None, y=None):
        """Scroll using VNC scroll buttons (4=up, 5=down, 6=left, 7=right)"""
        if x is None: x = self.width // 2
        if y is None: y = self.height // 2

        button_map = {'up': 8, 'down': 16, 'left': 32, 'right': 64}
        button = button_map.get(direction, 16)

        self.send_pointer_event(x, y, 0)
        for _ in range(amount):
            self.send_pointer_event(x, y, button)
            time.sleep(0.02)
            self.send_pointer_event(x, y, 0)
            time.sleep(0.02)

    def capture_screenshot(self, output_file=None):
        """Capture framebuffer as PNG."""
        # Set pixel format
        pixel_format = struct.pack('>BBBBHHHBBBxxx',
            32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
        msg = struct.pack('>Bxxx', 0) + pixel_format
        self.sock.send(msg)

        # Set encodings (Raw only)
        msg = struct.pack('>BxH', 2, 1) + struct.pack('>i', 0)
        self.sock.send(msg)

        # Request framebuffer
        msg = struct.pack('>BBHHHH', 3, 0, 0, 0, self.width, self.height)
        self.sock.send(msg)

        # Receive framebuffer
        framebuffer = bytearray(self.width * self.height * 4)

        while True:
            msg_type = struct.unpack('B', self.recv_exact(1))[0]
            if msg_type == 0:
                _ = self.recv_exact(1)
                num_rects = struct.unpack('>H', self.recv_exact(2))[0]
                for _ in range(num_rects):
                    rx, ry, rw, rh, encoding = struct.unpack('>HHHHi', self.recv_exact(12))
                    if encoding == 0:
                        rect_data = self.recv_exact(rw * rh * 4)
                        for row in range(rh):
                            src_off = row * rw * 4
                            dst_off = ((ry + row) * self.width + rx) * 4
                            framebuffer[dst_off:dst_off + rw * 4] = rect_data[src_off:src_off + rw * 4]
                break
            elif msg_type == 1:
                _ = self.recv_exact(1)
                first = struct.unpack('>H', self.recv_exact(2))[0]
                num = struct.unpack('>H', self.recv_exact(2))[0]
                _ = self.recv_exact(num * 6)
            elif msg_type == 2:
                pass
            elif msg_type == 3:
                _ = self.recv_exact(3)
                tl = struct.unpack('>I', self.recv_exact(4))[0]
                _ = self.recv_exact(tl)
            else:
                break

        if Image:
            rgba = bytearray(len(framebuffer))
            for i in range(0, len(framebuffer), 4):
                rgba[i] = framebuffer[i + 2]
                rgba[i + 1] = framebuffer[i + 1]
                rgba[i + 2] = framebuffer[i]
                rgba[i + 3] = 255
            img = Image.frombytes('RGBA', (self.width, self.height), bytes(rgba))
            # Resize to max 768px wide for context-friendly base64 output
            max_w = 768
            if img.width > max_w:
                ratio = max_w / img.width
                new_h = int(img.height * ratio)
                img = img.resize((max_w, new_h), Image.LANCZOS)
            if output_file and output_file != '-b64':
                img.save(output_file, 'PNG')
                return f"OK:{self.width}x{self.height}"
            else:
                # Convert RGBA→RGB and save as JPEG for much smaller base64
                rgb = img.convert('RGB')
                buf = io.BytesIO()
                rgb.save(buf, 'JPEG', quality=60, optimize=True)
                return base64.b64encode(buf.getvalue()).decode('ascii')

        return base64.b64encode(bytes(framebuffer)).decode('ascii')


def main():
    if len(sys.argv) < 4:
        print("Usage: vnc-control.py HOST PORT ACTION [PARAMS...]", file=sys.stderr)
        print("       Password is read from stdin (one line).", file=sys.stderr)
        sys.exit(1)

    host = sys.argv[1]
    port = int(sys.argv[2])
    action = sys.argv[3].lower()
    params = sys.argv[4:]

    # Read password from stdin (secure — not visible in ps output)
    password = sys.stdin.readline().rstrip('\n') if not sys.stdin.isatty() else ''

    vnc = VNCConnection(host, port, password)
    try:
        vnc.connect()

        if action == 'screenshot':
            output = params[0] if params else '-b64'
            result = vnc.capture_screenshot(output)
            print(result)

        elif action == 'click':
            vnc.click(int(params[0]), int(params[1]))
            print(f"OK:click:{params[0]},{params[1]}")

        elif action == 'doubleclick':
            vnc.double_click(int(params[0]), int(params[1]))
            print(f"OK:doubleclick:{params[0]},{params[1]}")

        elif action == 'rightclick':
            vnc.right_click(int(params[0]), int(params[1]))
            print(f"OK:rightclick:{params[0]},{params[1]}")

        elif action == 'type':
            text = ' '.join(params)
            vnc.type_text(text)
            print(f"OK:type:{len(text)} chars")

        elif action == 'key':
            vnc.press_key(params[0])
            print(f"OK:key:{params[0]}")

        elif action == 'keycombo':
            vnc.key_combo(params[0])
            print(f"OK:keycombo:{params[0]}")

        elif action == 'scroll':
            direction = params[0] if params else 'down'
            amount = int(params[1]) if len(params) > 1 else 3
            x = int(params[2]) if len(params) > 2 else None
            y = int(params[3]) if len(params) > 3 else None
            vnc.scroll(direction, amount, x, y)
            print(f"OK:scroll:{direction}:{amount}")

        elif action == 'move':
            vnc.move(int(params[0]), int(params[1]))
            print(f"OK:move:{params[0]},{params[1]}")

        elif action == 'drag':
            vnc.drag(int(params[0]), int(params[1]), int(params[2]), int(params[3]))
            print(f"OK:drag:{params[0]},{params[1]}->{params[2]},{params[3]}")

        elif action == 'screensize':
            print(f"{vnc.width}x{vnc.height}")

        else:
            print(f"Unknown action: {action}", file=sys.stderr)
            sys.exit(1)

    finally:
        vnc.close()


if __name__ == '__main__':
    main()
