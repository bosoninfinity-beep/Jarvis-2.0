import { useRef, useEffect, useState, useCallback } from 'react';
import { authFetch } from '../../gateway/client.js';

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 3000; // 3s
const MAX_RECONNECT_DELAY = 30000; // 30s
const CLIPBOARD_SYNC_INTERVAL = 2000; // 2s

interface VNCViewerProps {
  host: string;
  port: number;
  id: string;
  /** 'smith' | 'johny' — used for file transfer & clipboard SSH target */
  target: string;
  username?: string;
  password?: string;
  viewOnly?: boolean;
  onStatusChange?: (status: VNCStatus) => void;
}

type VNCStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface RFBInstance {
  scaleViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  viewOnly: boolean;
  focusOnClick: boolean;
  clipViewport: boolean;
  qualityLevel: number;
  compressionLevel: number;
  disconnect: () => void;
  sendCtrlAltDel: () => void;
  sendKey: (keysym: number, code: string | null, down?: boolean) => void;
  sendCredentials: (creds: { username?: string; password?: string }) => void;
  focus: () => void;
  blur: () => void;
  clipboardPasteFrom: (text: string) => void;
  machineShutdown: () => void;
  machineReboot: () => void;
  machineReset: () => void;
  addEventListener: (event: string, handler: (...args: unknown[]) => void) => void;
  removeEventListener: (event: string, handler: (...args: unknown[]) => void) => void;
}

export function VNCViewer({ host, port, username, password, id, target, viewOnly = false, onStatusChange }: VNCViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBInstance | null>(null);
  const [status, setStatus] = useState<VNCStatus>('disconnected');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isFocused, setIsFocused] = useState(false);
  const [showToolbar, setShowToolbar] = useState(false);
  const [clipboardText, setClipboardText] = useState('');
  const [showClipboard, setShowClipboard] = useState(false);
  const [clipboardSync, setClipboardSync] = useState(true);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const mountedRef = useRef(true);
  const authFailedRef = useRef(false);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  // Drag & drop state
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; pct: number } | null>(null);
  const [uploadResult, setUploadResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const dragCounterRef = useRef(0);

  // Clipboard sync refs
  const lastRemoteClipboardRef = useRef('');
  const lastLocalClipboardRef = useRef('');
  const clipboardSyncRef = useRef(clipboardSync);
  clipboardSyncRef.current = clipboardSync;

  const updateStatus = useCallback((s: VNCStatus) => {
    if (!mountedRef.current) return;
    setStatus(s);
    onStatusChangeRef.current?.(s);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (authFailedRef.current) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      updateStatus('error');
      setErrorMsg(`Failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Click RETRY to try again.`);
      return;
    }
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current),
      MAX_RECONNECT_DELAY
    );
    reconnectAttemptsRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      void connectVNCInternal();
    }, delay);
  }, []);

  const connectVNCInternal = useCallback(async () => {
    if (!containerRef.current || !mountedRef.current) return;

    if (rfbRef.current) {
      try { rfbRef.current.disconnect(); } catch { /* ignore */ }
      rfbRef.current = null;
    }

    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }

    try {
      updateStatus('connecting');
      const wsUrl = `ws://${host}:${port}`;

      const mod = await import('@novnc/novnc/lib/rfb.js');
      const RFB = mod.default;

      if (!containerRef.current || !mountedRef.current) return;

      const credentials: Record<string, string> = {};
      if (username) credentials.username = username;
      if (password) credentials.password = password;

      const rfb = new RFB(containerRef.current, wsUrl, {
        credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
        wsProtocols: ['binary'],
      }) as unknown as RFBInstance;

      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.clipViewport = false;
      rfb.viewOnly = viewOnly;
      rfb.focusOnClick = true;
      rfb.showDotCursor = !viewOnly;
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 2;

      rfb.addEventListener('connect', () => {
        reconnectAttemptsRef.current = 0;
        updateStatus('connected');
        if (!viewOnly) rfb.focus();
      });

      rfb.addEventListener('credentialsrequired', () => {
        if (username && password) rfb.sendCredentials({ username, password });
        else if (password) rfb.sendCredentials({ password });
        else {
          updateStatus('error');
          setErrorMsg('Credentials required — set VNC username/password in Settings');
        }
      });

      rfb.addEventListener('disconnect', (e: unknown) => {
        const detail = (e as { detail?: { clean?: boolean } })?.detail;
        updateStatus('disconnected');
        rfbRef.current = null;
        if (!detail?.clean) scheduleReconnect();
      });

      rfb.addEventListener('securityfailure', (e: unknown) => {
        const detail = (e as { detail?: { reason?: string } })?.detail;
        authFailedRef.current = true;
        updateStatus('error');
        setErrorMsg(detail?.reason ?? 'Authentication failed');
      });

      // Clipboard from remote -> local
      rfb.addEventListener('clipboard', (e: unknown) => {
        const detail = (e as { detail?: { text?: string } })?.detail;
        if (detail?.text) {
          setClipboardText(detail.text);
          lastRemoteClipboardRef.current = detail.text;
          // Auto-copy to browser clipboard
          if (clipboardSyncRef.current) {
            void navigator.clipboard.writeText(detail.text).catch(() => {});
          }
        }
      });

      rfbRef.current = rfb;
    } catch (err) {
      updateStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to connect');
      scheduleReconnect();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, username, password, viewOnly]);

  useEffect(() => {
    mountedRef.current = true;
    reconnectAttemptsRef.current = 0;
    authFailedRef.current = false;
    void connectVNCInternal();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (rfbRef.current) {
        try { rfbRef.current.disconnect(); } catch { /* ignore */ }
        rfbRef.current = null;
      }
    };
  }, [connectVNCInternal]);

  // ── Auto clipboard sync: poll local clipboard + push to remote ──────
  useEffect(() => {
    if (status !== 'connected' || !clipboardSync) return;

    const interval = setInterval(async () => {
      if (!clipboardSyncRef.current || !rfbRef.current) return;

      // Local → Remote: read browser clipboard, send to VNC if changed
      try {
        const localText = await navigator.clipboard.readText();
        if (localText && localText !== lastLocalClipboardRef.current && localText !== lastRemoteClipboardRef.current) {
          lastLocalClipboardRef.current = localText;
          rfbRef.current.clipboardPasteFrom(localText);
        }
      } catch { /* clipboard API may not be available without focus */ }
    }, CLIPBOARD_SYNC_INTERVAL);

    return () => clearInterval(interval);
  }, [status, clipboardSync]);

  // ── Drag & drop file upload ─────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    for (const file of files) {
      setUploadProgress({ name: file.name, pct: 0 });
      setUploadResult(null);

      try {
        const buffer = await file.arrayBuffer();
        setUploadProgress({ name: file.name, pct: 50 });

        const res = await authFetch(
          `/api/vnc/upload?target=${encodeURIComponent(target)}&filename=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buffer,
          },
        );

        if (res.ok) {
          const data = await res.json() as { path: string; size: number };
          setUploadProgress({ name: file.name, pct: 100 });
          setUploadResult({ ok: true, msg: `${file.name} → ${data.path}` });
        } else {
          const data = await res.json().catch(() => ({ error: 'Upload failed' })) as { error: string };
          setUploadResult({ ok: false, msg: data.error });
        }
      } catch (err) {
        setUploadResult({ ok: false, msg: (err as Error).message });
      }
    }

    // Clear status after 4s
    setTimeout(() => {
      setUploadProgress(null);
      setUploadResult(null);
    }, 4000);
  }, [target]);

  const handleContainerClick = useCallback(() => {
    if (rfbRef.current && !viewOnly) {
      rfbRef.current.focus();
      setIsFocused(true);
    }
  }, [viewOnly]);

  const handleSendCtrlAltDel = useCallback(() => {
    rfbRef.current?.sendCtrlAltDel();
  }, []);

  const handlePasteClipboard = useCallback(() => {
    if (clipboardText && rfbRef.current) {
      rfbRef.current.clipboardPasteFrom(clipboardText);
    }
  }, [clipboardText]);

  const handleClipboardFromBrowser = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && rfbRef.current) {
        rfbRef.current.clipboardPasteFrom(text);
        setClipboardText(text);
        lastLocalClipboardRef.current = text;
      }
    } catch { /* Clipboard API may not be available */ }
  }, []);

  const handleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
    authFailedRef.current = false;
    void connectVNCInternal();
  }, [connectVNCInternal]);

  const handleSendEscape = useCallback(() => {
    rfbRef.current?.sendKey(0xff1b, 'Escape');
  }, []);

  const handleSendTab = useCallback(() => {
    rfbRef.current?.sendKey(0xff09, 'Tab');
  }, []);

  // Push clipboard to remote OS via SSH pbcopy
  const handlePushClipboardSSH = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      await authFetch(`/api/vnc/clipboard?target=${encodeURIComponent(target)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      setClipboardText(text);
    } catch { /* ignore */ }
  }, [target]);

  // Pull clipboard from remote OS via SSH pbpaste
  const handlePullClipboardSSH = useCallback(async () => {
    try {
      const res = await authFetch(`/api/vnc/clipboard?target=${encodeURIComponent(target)}`);
      if (res.ok) {
        const data = await res.json() as { text: string };
        if (data.text) {
          setClipboardText(data.text);
          await navigator.clipboard.writeText(data.text).catch(() => {});
          lastRemoteClipboardRef.current = data.text;
        }
      }
    } catch { /* ignore */ }
  }, [target]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-primary)',
      }}
      onMouseEnter={() => setShowToolbar(true)}
      onMouseLeave={() => { setShowToolbar(false); setShowClipboard(false); }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {/* ── Drag & Drop overlay ─────────────────────────────────────── */}
      {isDragging && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 30,
          background: 'rgba(0,255,65,0.08)',
          border: '3px dashed var(--green-bright)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
          backdropFilter: 'blur(2px)',
        }}>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: 18, letterSpacing: 4,
            color: 'var(--green-bright)', textShadow: 'var(--glow-green-strong)',
            marginBottom: 8,
          }}>
            DROP FILES
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Files will be transferred to {target.toUpperCase()} Desktop via SCP
          </div>
        </div>
      )}

      {/* ── Upload progress / result toast ──────────────────────────── */}
      {(uploadProgress || uploadResult) && (
        <div style={{
          position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 30, padding: '6px 16px',
          background: 'rgba(10,10,10,0.95)',
          border: `1px solid ${uploadResult ? (uploadResult.ok ? 'var(--green-bright)' : 'var(--red-bright)') : 'var(--cyan-bright)'}`,
          borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-mono)',
          color: uploadResult ? (uploadResult.ok ? 'var(--green-bright)' : 'var(--red-bright)') : 'var(--cyan-bright)',
          maxWidth: '80%', textAlign: 'center',
          boxShadow: uploadResult?.ok ? '0 0 12px rgba(0,255,65,0.3)' : undefined,
        }}>
          {uploadResult
            ? (uploadResult.ok ? `✓ ${uploadResult.msg}` : `✗ ${uploadResult.msg}`)
            : `↑ ${uploadProgress!.name} — ${uploadProgress!.pct}%`
          }
        </div>
      )}

      {/* ── Interactive Toolbar ──────────────────────────────────────── */}
      {status === 'connected' && !viewOnly && (
        <div style={{
          position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
          zIndex: 20, display: 'flex', gap: 2, padding: '2px 4px',
          background: showToolbar ? 'rgba(10,10,10,0.95)' : 'transparent',
          border: showToolbar ? '1px solid var(--border-primary)' : 'none',
          borderTop: 'none', borderRadius: '0 0 4px 4px',
          transition: 'all 0.2s ease', opacity: showToolbar ? 1 : 0,
        }}>
          <ToolBtn label="Ctrl+Alt+Del" onClick={handleSendCtrlAltDel} />
          <ToolBtn label="Esc" onClick={handleSendEscape} />
          <ToolBtn label="Tab" onClick={handleSendTab} />
          <ToolBtn label="Clipboard" onClick={() => setShowClipboard(!showClipboard)} active={showClipboard} />
          <ToolBtn label="Paste" onClick={() => void handleClipboardFromBrowser()} title="Paste from browser clipboard" />
          <ToolBtn
            label={clipboardSync ? 'SYNC ON' : 'SYNC OFF'}
            onClick={() => setClipboardSync(!clipboardSync)}
            active={clipboardSync}
            color={clipboardSync ? 'var(--green-bright)' : 'var(--text-muted)'}
            title="Auto-sync clipboard between local and remote"
          />
          <ToolBtn label="Reconnect" onClick={handleReconnect} color="var(--amber)" />
        </div>
      )}

      {/* ── Clipboard panel ─────────────────────────────────────────── */}
      {showClipboard && status === 'connected' && (
        <div style={{
          position: 'absolute', top: 28, left: '50%', transform: 'translateX(-50%)',
          zIndex: 20, width: 320,
          background: 'rgba(10,10,10,0.95)',
          border: '1px solid var(--border-primary)', borderRadius: 4, padding: 8,
        }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4, letterSpacing: 1 }}>
            CLIPBOARD — {target.toUpperCase()}
          </div>
          <textarea
            value={clipboardText}
            onChange={(e) => setClipboardText(e.target.value)}
            style={{
              width: '100%', height: 60,
              background: 'var(--bg-primary)', border: '1px solid var(--border-dim)',
              color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
              fontSize: 11, padding: 4, resize: 'none', borderRadius: 2,
            }}
          />
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button onClick={handlePasteClipboard} style={{
              fontSize: 9, padding: '2px 8px', flex: 1,
              background: 'rgba(0,255,65,0.1)', border: '1px solid var(--green-dim)',
              color: 'var(--green-bright)', cursor: 'pointer',
            }}>
              SEND (VNC)
            </button>
            <button onClick={() => void handlePushClipboardSSH()} style={{
              fontSize: 9, padding: '2px 8px', flex: 1,
              background: 'rgba(0,255,255,0.1)', border: '1px solid var(--cyan-dim)',
              color: 'var(--cyan-bright)', cursor: 'pointer',
            }}>
              PUSH (SSH)
            </button>
            <button onClick={() => void handlePullClipboardSSH()} style={{
              fontSize: 9, padding: '2px 8px', flex: 1,
              background: 'rgba(160,100,255,0.1)', border: '1px solid rgba(160,100,255,0.4)',
              color: 'rgb(180,130,255)', cursor: 'pointer',
            }}>
              PULL (SSH)
            </button>
          </div>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', marginTop: 4, opacity: 0.7 }}>
            VNC = RFB clipboard | SSH = macOS pbcopy/pbpaste (works always)
          </div>
        </div>
      )}

      {/* Focus indicator */}
      {status === 'connected' && isFocused && !viewOnly && (
        <div style={{
          position: 'absolute', inset: 0,
          border: '2px solid var(--green-bright)',
          boxShadow: 'inset 0 0 10px rgba(0,255,65,0.1)',
          pointerEvents: 'none', zIndex: 15, borderRadius: 1,
        }} />
      )}

      {/* VNC Canvas Container */}
      <div
        ref={containerRef}
        onClick={handleContainerClick}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        tabIndex={0}
        style={{
          flex: 1, width: '100%',
          cursor: viewOnly ? 'default' : 'none',
          outline: 'none', overflow: 'hidden',
        }}
      />

      {/* Status overlay */}
      {status !== 'connected' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', zIndex: 10,
        }}>
          {status === 'connecting' && (
            <>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 14,
                color: 'var(--green-muted)', letterSpacing: 2, marginBottom: 8,
              }}>CONNECTING</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{host}:{port}</div>
              <div style={{
                marginTop: 16, width: 60, height: 2,
                background: 'var(--green-dim)', borderRadius: 1, overflow: 'hidden',
              }}>
                <div style={{
                  width: '50%', height: '100%',
                  background: 'var(--green-bright)', boxShadow: 'var(--glow-green)',
                  animation: 'typing 1.5s ease-in-out infinite alternate',
                }} />
              </div>
            </>
          )}
          {status === 'disconnected' && (
            <>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 13,
                color: 'var(--text-muted)', letterSpacing: 2, marginBottom: 8,
              }}>VNC OFFLINE</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {id} - Waiting for connection...
              </div>
              <div style={{
                fontSize: 10, color: 'var(--green-dim)', marginTop: 8,
                fontFamily: 'var(--font-mono)',
              }}>websockify {port} localhost:5900</div>
              <button onClick={handleReconnect} style={{
                marginTop: 16, fontSize: 10, padding: '4px 12px',
                background: 'rgba(0,255,65,0.1)',
                border: '1px solid var(--green-dim)',
                color: 'var(--green-bright)', cursor: 'pointer', borderRadius: 2,
              }}>RECONNECT</button>
            </>
          )}
          {status === 'error' && (
            <>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 13,
                color: 'var(--red-bright)', letterSpacing: 2,
                textShadow: 'var(--glow-red)', marginBottom: 8,
              }}>CONNECTION ERROR</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {errorMsg || 'Unable to connect to VNC server'}
              </div>
              <button onClick={handleReconnect} style={{
                marginTop: 16, fontSize: 10, padding: '4px 12px',
                background: 'rgba(255,50,50,0.1)',
                border: '1px solid var(--red-dim)',
                color: 'var(--red-bright)', cursor: 'pointer', borderRadius: 2,
              }}>RETRY</button>
            </>
          )}
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage:
              'linear-gradient(rgba(0,255,65,0.02) 1px, transparent 1px),' +
              'linear-gradient(90deg, rgba(0,255,65,0.02) 1px, transparent 1px)',
            backgroundSize: '30px 30px', pointerEvents: 'none',
          }} />
        </div>
      )}
    </div>
  );
}

function ToolBtn({ label, onClick, color, active, title }: {
  label: string;
  onClick: () => void;
  color?: string;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      style={{
        fontSize: 8, padding: '2px 6px',
        background: active ? 'rgba(0,255,255,0.15)' : 'transparent',
        border: `1px solid ${active ? 'var(--cyan-bright)' : 'var(--border-dim)'}`,
        color: color ?? 'var(--text-secondary)',
        cursor: 'pointer', borderRadius: 2,
        fontFamily: 'var(--font-mono)', letterSpacing: 0.5, whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
