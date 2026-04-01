#!/usr/bin/env bash
###############################################################################
#  JARVIS 2.0 // MASTER NODE INSTALLER (Full Auto)
#
#  Jednorazowy instalator - uruchom i odpowiedz na pytania.
#  Instaluje WSZYSTKO: Homebrew, Node 22, pnpm, NATS, Redis,
#  skanuje siec, konfiguruje SSH do agentow, montuje NAS,
#  generuje token, uruchamia system.
#
#  Uruchom:  chmod +x install-master.sh && ./install-master.sh
###############################################################################

set -euo pipefail

# ─── Kolory / UI ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; MAGENTA='\033[0;35m'
BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

JARVIS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NATS_PORT=4222; REDIS_PORT=6379; GATEWAY_PORT=18900; DASHBOARD_PORT=3000
AUTH_TOKEN="jarvis-$(openssl rand -hex 16)"
MY_IP=""
NAS_IP=""; NAS_USER=""; NAS_PASS=""; NAS_SHARE=""
NAS_MOUNT="/Volumes/JarvisNAS/jarvis"
ALPHA_IP=""; ALPHA_USER=""
BETA_IP=""; BETA_USER=""

banner() {
  clear
  echo ""
  echo -e "${GREEN}  ╔═══════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}     ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗${RESET}     ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}     ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝${RESET}     ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}     ██║███████║██████╔╝██║   ██║██║███████╗${RESET}     ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║${RESET}     ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║${RESET}     ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN} ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝${RESET}     ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}                     ${DIM}v2.0 // MASTER INSTALLER${RESET}                 ${GREEN}║${RESET}"
  echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
  echo -e "${GREEN}  ╚═══════════════════════════════════════════════════════════════╝${RESET}"
  echo ""
}

step()  { echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo -e "${CYAN}  KROK: ${BOLD}$1${RESET}"; echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "  ${RED}✗ $1${RESET}"; }
ask()   { echo -ne "  ${MAGENTA}?${RESET} $1: "; }
check_command() { command -v "$1" >/dev/null 2>&1; }

# ─── Wykryj moje IP ─────────────────────────────────────────────────────────
detect_my_ip() {
  # Preferuj en0 (WiFi/Ethernet na macOS)
  MY_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")
  if [[ -z "$MY_IP" ]]; then
    MY_IP=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')
  fi
}

# ─── Skanowanie sieci ───────────────────────────────────────────────────────
scan_network() {
  local subnet="$1"
  echo -e "  ${DIM}Skanowanie $subnet ...${RESET}"

  # Szybki ARP scan
  local found=()
  # Ping sweep (dziala bez nmap)
  for i in $(seq 1 254); do
    ping -c 1 -W 1 "${subnet}.${i}" &>/dev/null && found+=("${subnet}.${i}") &
    # Limit rownoleglych pingow
    [[ $(( i % 50 )) -eq 0 ]] && wait
  done
  wait

  # Pokaz znalezione hosty
  if [[ ${#found[@]} -gt 0 ]]; then
    echo ""
    echo -e "  ${BOLD}Znalezione urzadzenia w sieci:${RESET}"
    echo ""
    local idx=1
    for ip in "${found[@]}"; do
      local hostname_str=""
      hostname_str=$(host "$ip" 2>/dev/null | grep 'domain name' | awk '{print $NF}' | sed 's/\.$//' || echo "")
      local arp_mac=""
      arp_mac=$(arp -n "$ip" 2>/dev/null | awk '{print $4}' | grep -v incomplete || echo "")
      printf "    ${GREEN}%2d)${RESET} %-16s  ${DIM}%s  %s${RESET}\n" "$idx" "$ip" "$hostname_str" "$arp_mac"
      idx=$((idx + 1))
    done
    echo ""
    # Zapisz do globalnej tablicy
    SCAN_RESULTS=("${found[@]}")
  else
    echo -e "  ${YELLOW}Nie znaleziono urzadzen${RESET}"
    SCAN_RESULTS=()
  fi
}

pick_ip() {
  local prompt_text="$1"
  local result_var="$2"

  echo ""
  echo -e "  ${BOLD}$prompt_text${RESET}"
  echo -e "  ${DIM}[S] Skanuj siec  |  [IP] Wpisz reczne IP  |  [-] Pomin${RESET}"
  ask "Wybor"
  read -r choice

  if [[ "${choice,,}" == "s" ]]; then
    local subnet
    subnet=$(echo "$MY_IP" | sed 's/\.[0-9]*$//')
    scan_network "$subnet"

    if [[ ${#SCAN_RESULTS[@]} -gt 0 ]]; then
      ask "Numer z listy lub wpisz IP"
      read -r pick
      if [[ "$pick" =~ ^[0-9]+$ ]] && [[ "$pick" -ge 1 ]] && [[ "$pick" -le ${#SCAN_RESULTS[@]} ]]; then
        eval "$result_var=\"${SCAN_RESULTS[$((pick-1))]}\""
      else
        eval "$result_var=\"$pick\""
      fi
    else
      ask "Wpisz IP recznie"
      read -r manual_ip
      eval "$result_var=\"$manual_ip\""
    fi
  elif [[ "$choice" == "-" ]]; then
    eval "$result_var=\"\""
  else
    eval "$result_var=\"$choice\""
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
#  START INSTALACJI
# ═══════════════════════════════════════════════════════════════════════════
banner
detect_my_ip

echo -e "  ${DIM}Katalog projektu:  ${JARVIS_DIR}${RESET}"
echo -e "  ${DIM}macOS:             $(sw_vers -productVersion) ($(uname -m))${RESET}"
echo -e "  ${DIM}Moje IP:           ${MY_IP}${RESET}"
echo -e "  ${DIM}Data:              $(date)${RESET}"
echo ""
echo -e "  ${YELLOW}Ten instalator zainstaluje wszystko automatycznie.${RESET}"
echo -e "  ${YELLOW}Bedziesz odpowiadac na kilka pytan o siec.${RESET}"
echo ""
echo -ne "  ${MAGENTA}?${RESET} Nacisnij ENTER zeby kontynuowac (Ctrl+C = anuluj)..."
read -r

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 1: INSTALACJA ZALEZNOSCI
# ═════════════════════════════════════════════════════════════════════════
step "1/8  Instalacja zaleznosci systemowych"

# --- Homebrew ---
if check_command brew; then
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  echo -e "  ${DIM}Instalowanie Homebrew...${RESET}"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)" && echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  ok "Homebrew zainstalowany"
fi

# --- Node.js 22 ---
NODE_V=""; check_command node && NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ -n "$NODE_V" ]] && [[ "$NODE_V" -ge 22 ]]; then
  ok "Node.js $(node -v)"
else
  echo -e "  ${DIM}Instalowanie Node.js 22...${RESET}"
  brew install node@22
  brew link node@22 --overwrite --force 2>/dev/null || true
  NP="$(brew --prefix node@22)/bin"
  echo "$PATH" | grep -q "$NP" || { export PATH="$NP:$PATH"; echo "export PATH=\"$NP:\$PATH\"" >> ~/.zprofile; }
  ok "Node.js $(node -v)"
fi

# --- pnpm ---
if check_command pnpm; then ok "pnpm $(pnpm -v)"; else npm install -g pnpm; ok "pnpm $(pnpm -v)"; fi

# --- NATS ---
if check_command nats-server; then ok "NATS Server"; else brew install nats-server; ok "NATS Server zainstalowany"; fi

# --- Redis ---
if check_command redis-server; then ok "Redis"; else brew install redis; ok "Redis zainstalowany"; fi

# --- Projekt npm deps ---
echo -e "  ${DIM}pnpm install...${RESET}"
cd "$JARVIS_DIR" && pnpm install --reporter=silent 2>&1 | tail -1
ok "Zalenosci projektu zainstalowane"

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 2: KONFIGURACJA SIECI
# ═════════════════════════════════════════════════════════════════════════
step "2/8  Konfiguracja sieci - NAS"

echo ""
echo -e "  ${BOLD}Czy masz QNAP NAS (lub inny NAS z SMB)?${RESET}"
echo -e "  ${DIM}[Y] Tak - skonfiguruj NAS  |  [N] Nie - uzyj lokalnego katalogu${RESET}"
ask "NAS"
read -r has_nas

if [[ "${has_nas,,}" == "y" || "${has_nas,,}" == "tak" ]]; then
  pick_ip "Podaj IP NAS-a" NAS_IP

  if [[ -n "$NAS_IP" ]]; then
    ask "Nazwa udzialu SMB (np. jarvis-nas)"
    read -r NAS_SHARE
    NAS_SHARE="${NAS_SHARE:-jarvis-nas}"

    ask "Login do NAS"
    read -r NAS_USER

    ask "Haslo do NAS (nie bedzie widoczne)"
    read -rs NAS_PASS
    echo ""

    # Validate inputs to prevent shell injection
    if [[ "$NAS_USER" =~ [^a-zA-Z0-9._@-] ]]; then
      fail "NAS user zawiera niedozwolone znaki"; exit 1
    fi
    if [[ "$NAS_SHARE" =~ [^a-zA-Z0-9._-] ]]; then
      fail "NAS share zawiera niedozwolone znaki"; exit 1
    fi
    if [[ "$NAS_IP" =~ [^a-zA-Z0-9._:-] ]]; then
      fail "NAS IP zawiera niedozwolone znaki"; exit 1
    fi

    # --- Montowanie NAS ---
    echo -e "  ${DIM}Montowanie NAS...${RESET}"
    sudo mkdir -p /Volumes/JarvisNAS

    if mount -t smbfs "//${NAS_USER}:${NAS_PASS}@${NAS_IP}/${NAS_SHARE}" /Volumes/JarvisNAS 2>/dev/null; then
      ok "NAS zamontowany: /Volumes/JarvisNAS"
      NAS_MOUNT="/Volumes/JarvisNAS/jarvis"
      mkdir -p "$NAS_MOUNT"

      # --- Auto-mount launchd ---
      echo -e "  ${DIM}Konfigurowanie auto-mount po restarcie...${RESET}"

      # Zapisz haslo w Keychain (bezpieczniej niz w pliku)
      security add-internet-password -a "$NAS_USER" -s "$NAS_IP" -w "$NAS_PASS" -r "smb " -T /sbin/mount_smbfs 2>/dev/null || true

      AUTOMOUNT_SCRIPT="$JARVIS_DIR/scripts/mount-nas.sh"
      cat > "$AUTOMOUNT_SCRIPT" << MOUNTEOF
#!/usr/bin/env bash
# Auto-mount Jarvis NAS
NAS_IP="${NAS_IP}"
NAS_USER="${NAS_USER}"
NAS_SHARE="${NAS_SHARE}"
MOUNT_POINT="/Volumes/JarvisNAS"

# Sprawdz czy juz zamontowany
if mount | grep -q "\$MOUNT_POINT"; then
  exit 0
fi

mkdir -p "\$MOUNT_POINT"

# Pobierz haslo z Keychain
NAS_PASS=\$(security find-internet-password -a "\$NAS_USER" -s "\$NAS_IP" -w 2>/dev/null || echo "")

if [[ -n "\$NAS_PASS" ]]; then
  mount -t smbfs "//\${NAS_USER}:\${NAS_PASS}@\${NAS_IP}/\${NAS_SHARE}" "\$MOUNT_POINT" 2>/dev/null
fi
MOUNTEOF
      chmod +x "$AUTOMOUNT_SCRIPT"

      # LaunchAgent do auto-mount
      MOUNT_PLIST="$HOME/Library/LaunchAgents/com.jarvis.nas-mount.plist"
      cat > "$MOUNT_PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jarvis.nas-mount</string>
    <key>ProgramArguments</key>
    <array>
        <string>${AUTOMOUNT_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>120</integer>
</dict>
</plist>
PLISTEOF
      launchctl load "$MOUNT_PLIST" 2>/dev/null || true
      ok "Auto-mount skonfigurowany (launchd + Keychain)"
    else
      warn "Nie udalo sie zamontowac NAS - sprawdz dane"
      warn "Uzywam lokalnego katalogu jako fallback"
      NAS_MOUNT="$JARVIS_DIR/../jarvis-nas"
    fi
  fi
else
  echo -e "  ${DIM}Uzywam lokalnego katalogu jako storage${RESET}"
  NAS_MOUNT="$JARVIS_DIR/../jarvis-nas"
fi

# Utworz strukture NAS
for dir in sessions workspace/projects workspace/artifacts knowledge knowledge/entries logs media media/social config; do
  mkdir -p "$NAS_MOUNT/$dir"
done
ok "Struktura katalogow: $NAS_MOUNT"

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 3: KONFIGURACJA AGENTOW (SLAVE)
# ═════════════════════════════════════════════════════════════════════════
step "3/8  Konfiguracja agentow (Mac Mini Alpha / Beta)"

echo ""
echo -e "  ${BOLD}Podaj adresy IP komputerow-agentow.${RESET}"
echo -e "  ${DIM}Mozesz skanowac siec [S] lub wpisac IP recznie.${RESET}"
echo -e "  ${DIM}Pomin [-] jesli agent nie jest jeszcze podlaczony.${RESET}"

# --- Alpha (Dev) ---
echo ""
echo -e "  ${CYAN}── MAC MINI ALPHA (Developer) ──${RESET}"
pick_ip "IP Mac Mini Alpha" ALPHA_IP
if [[ -n "$ALPHA_IP" ]]; then
  ask "Login SSH na Alpha (domyslnie: $(whoami))"
  read -r ALPHA_USER
  ALPHA_USER="${ALPHA_USER:-$(whoami)}"
  ok "Alpha: ${ALPHA_USER}@${ALPHA_IP}"
fi

# --- Beta (Marketing) ---
echo ""
echo -e "  ${CYAN}── MAC MINI BETA (Marketing) ──${RESET}"
pick_ip "IP Mac Mini Beta" BETA_IP
if [[ -n "$BETA_IP" ]]; then
  ask "Login SSH na Beta (domyslnie: $(whoami))"
  read -r BETA_USER
  BETA_USER="${BETA_USER:-$(whoami)}"
  ok "Beta: ${BETA_USER}@${BETA_IP}"
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 4: SSH KEYS (automatyczna konfiguracja)
# ═════════════════════════════════════════════════════════════════════════
step "4/8  Konfiguracja SSH (klucze bezhasla)"

SSH_KEY="$HOME/.ssh/jarvis_ed25519"

# Generuj klucz jesli nie istnieje
if [[ ! -f "$SSH_KEY" ]]; then
  echo -e "  ${DIM}Generowanie klucza SSH...${RESET}"
  ssh-keygen -t ed25519 -C "jarvis-master-$(date +%Y%m%d)" -f "$SSH_KEY" -N "" -q
  chmod 600 "$SSH_KEY"
  chmod 644 "${SSH_KEY}.pub"
  ok "Klucz SSH wygenerowany: $SSH_KEY (permissions: 600)"
else
  ok "Klucz SSH juz istnieje: $SSH_KEY"
fi

# Kopiuj klucz na agentow
setup_ssh_for_host() {
  local host_ip="$1"
  local host_user="$2"
  local host_name="$3"

  if [[ -z "$host_ip" ]]; then return; fi

  echo -e "  ${DIM}Kopiowanie klucza na ${host_name} (${host_user}@${host_ip})...${RESET}"
  echo -e "  ${YELLOW}Moze poprosic o haslo SSH do ${host_name} - to jednorazowo!${RESET}"

  if ssh-copy-id -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "${host_user}@${host_ip}" 2>/dev/null; then
    ok "Klucz skopiowany na $host_name"
  else
    warn "Nie udalo sie skopiowac klucza na $host_name"
    warn "Skopiuj pozniej: ssh-copy-id -i $SSH_KEY ${host_user}@${host_ip}"
  fi

  # Dodaj do ~/.ssh/config
  local config_entry="
# Jarvis - $host_name
Host $host_name
  HostName $host_ip
  User $host_user
  IdentityFile $SSH_KEY
  StrictHostKeyChecking accept-new
"
  # Dodaj tylko jesli nie istnieje
  if ! grep -q "Host $host_name" "$HOME/.ssh/config" 2>/dev/null; then
    echo "$config_entry" >> "$HOME/.ssh/config"
    chmod 600 "$HOME/.ssh/config"
    ok "Dodano $host_name do ~/.ssh/config"
  fi

  # Test polaczenia
  if ssh -i "$SSH_KEY" -o ConnectTimeout=5 "${host_user}@${host_ip}" "echo OK" 2>/dev/null | grep -q OK; then
    ok "SSH do $host_name dziala!"
  else
    warn "SSH do $host_name jeszcze nie dziala - sprawdz pozniej"
  fi
}

[[ -n "$ALPHA_IP" ]] && setup_ssh_for_host "$ALPHA_IP" "$ALPHA_USER" "jarvis-alpha"
[[ -n "$BETA_IP" ]]  && setup_ssh_for_host "$BETA_IP" "$BETA_USER" "jarvis-beta"

if [[ -z "$ALPHA_IP" && -z "$BETA_IP" ]]; then
  warn "Brak agentow - SSH konfiguracja pominieta"
  warn "Dodaj pozniej: ssh-copy-id -i $SSH_KEY user@ip"
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 4.5: THUNDERBOLT BRIDGE DETECTION (10 Gbps USB-C)
# ═════════════════════════════════════════════════════════════════════════
echo ""
echo -e "  ${YELLOW}Thunderbolt Bridge Detection...${RESET}"

TB_ENABLED=false
TB_MASTER_IP="10.0.1.1"
TB_ALPHA_IP="10.0.1.2"
TB_BETA_IP="10.0.1.3"
TB_NATS_PORT=4223

# Detect Thunderbolt Bridge interface
TB_IFACE=$(networksetup -listallhardwareports 2>/dev/null | grep -A1 "Thunderbolt Bridge" | grep "Device" | awk '{print $2}')

if [[ -n "$TB_IFACE" ]]; then
  ok "Thunderbolt Bridge interface wykryty: $TB_IFACE"

  # Check if cable is connected (link active)
  TB_CURRENT_IP=$(ipconfig getifaddr "$TB_IFACE" 2>/dev/null || true)

  if [[ -n "$TB_CURRENT_IP" ]]; then
    ok "Thunderbolt aktywny, obecny IP: $TB_CURRENT_IP"
  else
    warn "Thunderbolt Bridge istnieje ale brak polaczenia (podlacz kabel USB-C)"
  fi

  echo ""
  ask "Chcesz wlaczyc Thunderbolt Bridge cluster? (10 Gbps) [t/N]"
  read -r tb_answer
  if [[ "$tb_answer" =~ ^[tTyY] ]]; then
    TB_ENABLED=true

    # Assign static IP if not already set
    if [[ -z "$TB_CURRENT_IP" || "$TB_CURRENT_IP" != "$TB_MASTER_IP" ]]; then
      echo -e "  ${DIM}Przypisywanie IP ${TB_MASTER_IP} do Thunderbolt Bridge...${RESET}"
      networksetup -setmanual "Thunderbolt Bridge" "$TB_MASTER_IP" "255.255.255.0" 2>/dev/null || {
        warn "Nie udalo sie ustawic IP - moze wymagac sudo"
        warn "Reczne: sudo networksetup -setmanual 'Thunderbolt Bridge' $TB_MASTER_IP 255.255.255.0"
      }
    fi

    ok "Thunderbolt Bridge ENABLED"
    echo -e "  ${DIM}Master TB IP: ${TB_MASTER_IP}${RESET}"
    echo -e "  ${DIM}Alpha TB IP:  ${TB_ALPHA_IP}${RESET}"
    echo -e "  ${DIM}Beta TB IP:   ${TB_BETA_IP}${RESET}"
    echo -e "  ${DIM}NATS TB port: ${TB_NATS_PORT}${RESET}"
  else
    ok "Thunderbolt pominieta - uzywa WiFi/Ethernet"
  fi
else
  echo -e "  ${DIM}Brak interfejsu Thunderbolt Bridge (brak kabla lub nie Mac Mini)${RESET}"
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 5: GENEROWANIE .env
# ═════════════════════════════════════════════════════════════════════════
step "5/8  Generowanie konfiguracji"

ENV_FILE="$JARVIS_DIR/.env"
[[ -f "$ENV_FILE" ]] && cp "$ENV_FILE" "$ENV_FILE.backup.$(date +%Y%m%d%H%M%S)"

cat > "$ENV_FILE" << ENVEOF
# ═══════════════════════════════════════════════════════════
#  JARVIS 2.0 // MASTER CONFIGURATION
#  Wygenerowano automatycznie: $(date)
#  Master IP: ${MY_IP}
# ═══════════════════════════════════════════════════════════

# ─── Gateway ──────────────────────────────────────────────
JARVIS_PORT=${GATEWAY_PORT}
JARVIS_HOST=0.0.0.0
JARVIS_AUTH_TOKEN=${AUTH_TOKEN}

# ─── Infrastructure ──────────────────────────────────────
NATS_URL=nats://0.0.0.0:${NATS_PORT}
REDIS_URL=redis://localhost:${REDIS_PORT}

# ─── NAS Storage ─────────────────────────────────────────
JARVIS_NAS_MOUNT=${NAS_MOUNT}

# ─── LLM Providers (dodaj swoje klucze) ─────────────────
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_AI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_HOST=http://localhost:11434

# ─── VNC Remote Desktops ────────────────────────────────
VNC_ALPHA_HOST=${ALPHA_IP:-mac-mini-alpha}
VNC_ALPHA_PORT=6080
VNC_BETA_HOST=${BETA_IP:-mac-mini-beta}
VNC_BETA_PORT=6080

# ─── Network ────────────────────────────────────────────
MASTER_IP=${MY_IP}
ALPHA_IP=${ALPHA_IP}
ALPHA_USER=${ALPHA_USER:-$(whoami)}
BETA_IP=${BETA_IP}
BETA_USER=${BETA_USER:-$(whoami)}
NAS_IP=${NAS_IP}

# ─── Dashboard ──────────────────────────────────────────
DASHBOARD_PORT=${DASHBOARD_PORT}

# ─── Thunderbolt Bridge (10 Gbps USB-C) ────────────────
THUNDERBOLT_ENABLED=${TB_ENABLED}
MASTER_IP_THUNDERBOLT=${TB_MASTER_IP}
ALPHA_IP_THUNDERBOLT=${TB_ALPHA_IP}
BETA_IP_THUNDERBOLT=${TB_BETA_IP}
NATS_URL_THUNDERBOLT=nats://${TB_MASTER_IP}:${TB_NATS_PORT}
VNC_ALPHA_HOST_THUNDERBOLT=${TB_ALPHA_IP}
VNC_BETA_HOST_THUNDERBOLT=${TB_BETA_IP}
ENVEOF

ok "Plik .env wygenerowany"
echo -e "  ${DIM}Auth token: ${AUTH_TOKEN}${RESET}"

# ─── NATS Config ────────────────────────────────────────
NATS_CONF="$JARVIS_DIR/scripts/nats.conf"
if [[ "$TB_ENABLED" == "true" ]]; then
  # Dual-listen: WiFi + Thunderbolt
  cat > "$NATS_CONF" << NATSEOF
# JARVIS 2.0 NATS Configuration (Thunderbolt + WiFi)
server_name: jarvis-master

# Primary listener - WiFi/Ethernet (all interfaces)
listen: 0.0.0.0:${NATS_PORT}

# Thunderbolt Bridge listener - fast lane (10 Gbps)
listen: ${TB_MASTER_IP}:${TB_NATS_PORT}

max_payload: 8MB
max_connections: 256
logtime: true
NATSEOF
  ok "NATS config: dual-listen (WiFi:${NATS_PORT} + TB:${TB_NATS_PORT})"
else
  cat > "$NATS_CONF" << NATSEOF
# JARVIS 2.0 NATS Configuration
server_name: jarvis-master
port: ${NATS_PORT}
host: 0.0.0.0
max_payload: 8MB
max_connections: 256
logtime: true
NATSEOF
  ok "NATS config: single listener (port ${NATS_PORT})"
fi

# ─── Zapisz config sieci do JSON (dla Dashboard) ────────
NET_CONFIG="$NAS_MOUNT/config/network.json"
cat > "$NET_CONFIG" << NETEOF
{
  "master": {
    "ip": "${MY_IP}",
    "hostname": "$(hostname)",
    "ports": { "gateway": ${GATEWAY_PORT}, "dashboard": ${DASHBOARD_PORT}, "nats": ${NATS_PORT}, "redis": ${REDIS_PORT} }
  },
  "agents": {
    "alpha": { "ip": "${ALPHA_IP}", "user": "${ALPHA_USER:-}", "role": "dev", "vnc_port": 6080 },
    "beta": { "ip": "${BETA_IP}", "user": "${BETA_USER:-}", "role": "marketing", "vnc_port": 6080 }
  },
  "nas": {
    "ip": "${NAS_IP}",
    "share": "${NAS_SHARE:-}",
    "mount": "${NAS_MOUNT}"
  },
  "thunderbolt": {
    "enabled": ${TB_ENABLED},
    "master_ip": "${TB_MASTER_IP}",
    "alpha_ip": "${TB_ALPHA_IP}",
    "beta_ip": "${TB_BETA_IP}",
    "nats_port": ${TB_NATS_PORT}
  },
  "auth_token": "${AUTH_TOKEN}",
  "generated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
NETEOF
ok "Config sieci: $NET_CONFIG"

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 6: DEPLOY AGENTOW (automatyczny)
# ═════════════════════════════════════════════════════════════════════════
step "6/8  Deploy kodu na agentow"

deploy_to_agent() {
  local agent_ip="$1"
  local agent_user="$2"
  local agent_id="$3"
  local agent_role="$4"
  local agent_name="$5"

  if [[ -z "$agent_ip" ]]; then return; fi

  echo ""
  echo -e "  ${BOLD}Deploying na ${agent_name} (${agent_user}@${agent_ip})...${RESET}"

  # Sprawdz SSH
  if ! ssh -i "$SSH_KEY" -o ConnectTimeout=5 "${agent_user}@${agent_ip}" "echo OK" 2>/dev/null | grep -q OK; then
    warn "SSH do $agent_name nie dziala - pomin deploy"
    warn "Uruchom pozniej: ./scripts/deploy-agent.sh $agent_name"
    return
  fi

  # Stworz katalog na agencie
  ssh -i "$SSH_KEY" "${agent_user}@${agent_ip}" "mkdir -p ~/Documents/Jarvis-2.0/jarvis" 2>/dev/null

  # Rsync projektu
  echo -e "  ${DIM}Kopiowanie projektu (rsync)...${RESET}"
  rsync -az --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'dist' \
    --exclude '.env' \
    --exclude '.env.backup.*' \
    -e "ssh -i $SSH_KEY" \
    "$JARVIS_DIR/" \
    "${agent_user}@${agent_ip}:~/Documents/Jarvis-2.0/jarvis/"
  ok "Kod skopiowany na $agent_name"

  # Wygeneruj .env na agencie
  echo -e "  ${DIM}Generowanie .env na agencie...${RESET}"
  ssh -i "$SSH_KEY" "${agent_user}@${agent_ip}" "cat > ~/Documents/Jarvis-2.0/jarvis/.env" << AGENTENVEOF
# JARVIS 2.0 // AGENT CONFIG (${agent_id})
# Wygenerowano automatycznie z Master

JARVIS_AGENT_ID=${agent_id}
JARVIS_AGENT_ROLE=${agent_role}
JARVIS_MACHINE_ID=${agent_name}

NATS_URL=nats://${MY_IP}:${NATS_PORT}
GATEWAY_URL=http://${MY_IP}:${GATEWAY_PORT}
JARVIS_AUTH_TOKEN=${AUTH_TOKEN}
JARVIS_NAS_MOUNT=${NAS_MOUNT}

# Thunderbolt Bridge
THUNDERBOLT_ENABLED=${TB_ENABLED}
NATS_URL_THUNDERBOLT=nats://${TB_MASTER_IP}:${TB_NATS_PORT}

ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_AI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_HOST=http://localhost:11434
AGENTENVEOF
  ok ".env wygenerowany na $agent_name"

  # Uruchom install-agent.sh zdalnie
  echo -e "  ${DIM}Uruchamianie instalatora na agencie...${RESET}"
  ssh -i "$SSH_KEY" "${agent_user}@${agent_ip}" "cd ~/Documents/Jarvis-2.0/jarvis && chmod +x scripts/install-agent.sh && scripts/install-agent.sh --agent-id ${agent_id} --role ${agent_role} --master-host ${MY_IP} --nas-mount ${NAS_MOUNT} --auth-token ${AUTH_TOKEN}" 2>&1 | while IFS= read -r line; do
    echo -e "    ${DIM}[$agent_name] $line${RESET}"
  done
  ok "$agent_name zainstalowany!"
}

deploy_to_agent "$ALPHA_IP" "$ALPHA_USER" "agent-smith" "dev" "jarvis-alpha"
deploy_to_agent "$BETA_IP" "$BETA_USER" "agent-johny" "marketing" "jarvis-beta"

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 7: URUCHAMIANIE SERWISOW
# ═════════════════════════════════════════════════════════════════════════
step "7/8  Uruchamianie serwisow Master"

is_port_open() { lsof -i ":$1" -P -n 2>/dev/null | grep -q LISTEN; }
wait_port() {
  local p=$1 n=$2 t=${3:-15} e=0
  while ! is_port_open "$p"; do sleep 1; e=$((e+1)); [[ $e -ge $t ]] && { fail "$n timeout"; return 1; }; done
  ok "$n dziala (port $p)"
}

# NATS
if is_port_open "$NATS_PORT"; then ok "NATS juz dziala"; else
  if [[ -f "$NATS_CONF" ]]; then nats-server -c "$NATS_CONF" &>/dev/null &
  else nats-server -p "$NATS_PORT" -a 0.0.0.0 &>/dev/null &; fi
  wait_port "$NATS_PORT" "NATS" 10
fi

# Redis
if is_port_open "$REDIS_PORT"; then ok "Redis juz dziala"; else
  redis-server --port "$REDIS_PORT" --daemonize yes 2>/dev/null
  wait_port "$REDIS_PORT" "Redis" 10
fi

# Gateway
if is_port_open "$GATEWAY_PORT"; then ok "Gateway juz dziala"; else
  cd "$JARVIS_DIR"
  if [[ -f "$JARVIS_DIR/node_modules/.pnpm/node_modules/.bin/tsx" ]]; then
    nohup "$JARVIS_DIR/node_modules/.pnpm/node_modules/.bin/tsx" packages/gateway/src/index.ts >> "$NAS_MOUNT/logs/gateway.log" 2>&1 &
  else
    nohup npx tsx packages/gateway/src/index.ts >> "$NAS_MOUNT/logs/gateway.log" 2>&1 &
  fi
  echo $! > /tmp/jarvis-gateway.pid
  wait_port "$GATEWAY_PORT" "Gateway" 20
fi

# Dashboard
if is_port_open "$DASHBOARD_PORT"; then ok "Dashboard juz dziala"; else
  cd "$JARVIS_DIR"
  nohup pnpm --filter @jarvis/dashboard dev >> "$NAS_MOUNT/logs/dashboard.log" 2>&1 &
  wait_port "$DASHBOARD_PORT" "Dashboard" 15
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 8: URUCHOM AGENTOW ZDALNIE
# ═════════════════════════════════════════════════════════════════════════
step "8/8  Uruchamianie agentow"

start_remote_agent() {
  local ip="$1" user="$2" name="$3"
  [[ -z "$ip" ]] && return

  echo -e "  ${DIM}Startowanie agenta na ${name}...${RESET}"
  if ssh -i "$SSH_KEY" -o ConnectTimeout=5 "${user}@${ip}" "cd ~/Documents/Jarvis-2.0/jarvis && scripts/jarvis-agent.sh start" 2>/dev/null; then
    ok "$name uruchomiony"
  else
    warn "Nie udalo sie uruchomic $name zdalnie"
    warn "Uruchom recznie na $name: ./scripts/jarvis-agent.sh start"
  fi
}

start_remote_agent "$ALPHA_IP" "$ALPHA_USER" "jarvis-alpha"
start_remote_agent "$BETA_IP" "$BETA_USER" "jarvis-beta"

# ═════════════════════════════════════════════════════════════════════════
#  PODSUMOWANIE
# ═════════════════════════════════════════════════════════════════════════
echo ""
echo ""
echo -e "${GREEN}  ╔═══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   ${BOLD}${CYAN}JARVIS 2.0 ZAINSTALOWANY I URUCHOMIONY!${RESET}                   ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ╠═══════════════════════════════════════════════════════════════╣${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Dashboard:  ${BOLD}http://localhost:${DASHBOARD_PORT}${RESET}                        ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Gateway:    ${BOLD}http://${MY_IP}:${GATEWAY_PORT}${RESET}               ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Master IP:  ${MY_IP}                                     ${GREEN}║${RESET}"
[[ -n "$ALPHA_IP" ]] && \
echo -e "${GREEN}  ║${RESET}   Alpha IP:   ${ALPHA_IP} (Dev)                            ${GREEN}║${RESET}"
[[ -n "$BETA_IP" ]] && \
echo -e "${GREEN}  ║${RESET}   Beta IP:    ${BETA_IP} (Marketing)                       ${GREEN}║${RESET}"
[[ -n "$NAS_IP" ]] && \
echo -e "${GREEN}  ║${RESET}   NAS IP:     ${NAS_IP}                                    ${GREEN}║${RESET}"
[[ "$TB_ENABLED" == "true" ]] && \
echo -e "${GREEN}  ║${RESET}   ${YELLOW}Thunderbolt: ENABLED (10 Gbps)${RESET}                          ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Auth Token: ${DIM}${AUTH_TOKEN}${RESET}  ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   ${DIM}Zarzadzanie:  ./scripts/jarvis.sh {start|stop|status}${RESET}    ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   ${DIM}Dodaj klucze: nano .env${RESET}                                  ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ╚═══════════════════════════════════════════════════════════════╝${RESET}"
echo ""

# Otworz dashboard
open "http://localhost:${DASHBOARD_PORT}" 2>/dev/null || true
