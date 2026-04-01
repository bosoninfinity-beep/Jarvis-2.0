#!/usr/bin/env bash
###############################################################################
#  JARVIS 2.0 // AGENT (SLAVE) INSTALLER (Full Auto)
#
#  Jednorazowy instalator - uruchom na Mac Mini Alpha lub Beta.
#  Wykrywa role automatycznie lub pyta. Instaluje wszystko.
#
#  Uzycie (w pelni automatyczne - parametry opcjonalne):
#    ./install-agent.sh
#
#  Lub z parametrami:
#    ./install-agent.sh --agent-id agent-smith --role dev --master-host 192.168.1.100
###############################################################################

set -euo pipefail

# ─── Kolory ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; MAGENTA='\033[0;35m'
BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

JARVIS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_ID=""; ROLE=""; MASTER_HOST=""
NAS_MOUNT="/Volumes/JarvisNAS/jarvis"
AUTH_TOKEN=""; VNC_PORT=5900; WSOCK_PORT=6080  # Updated after role selection

# ─── Parsowanie argumentow (opcjonalne) ─────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-id)    AGENT_ID="$2"; shift 2 ;;
    --role)        ROLE="$2"; shift 2 ;;
    --master-host) MASTER_HOST="$2"; shift 2 ;;
    --nas-mount)   NAS_MOUNT="$2"; shift 2 ;;
    --auth-token)  AUTH_TOKEN="$2"; shift 2 ;;
    -h|--help)
      echo "Uzycie: $0 [opcje]"
      echo "  --agent-id      agent-smith | agent-johny"
      echo "  --role          dev | marketing"
      echo "  --master-host   IP/hostname Master"
      echo "  --nas-mount     Sciezka NAS"
      echo "  --auth-token    Token autoryzacji"
      echo "  (wszystko opcjonalne - instalator zapyta)"
      exit 0
      ;;
    *) shift ;;
  esac
done

# ─── Funkcje ────────────────────────────────────────────────────────────────
step()  { echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo -e "${CYAN}  KROK: ${BOLD}$1${RESET}"; echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "  ${RED}✗ $1${RESET}"; }
ask()   { echo -ne "  ${MAGENTA}?${RESET} $1: "; }
check_command() { command -v "$1" >/dev/null 2>&1; }

detect_my_ip() {
  MY_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
  [[ -z "$MY_IP" ]] && MY_IP=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')
}

scan_for_master() {
  echo -e "  ${DIM}Szukanie Master (Gateway na porcie 18900)...${RESET}"
  local subnet
  subnet=$(echo "$MY_IP" | sed 's/\.[0-9]*$//')

  for i in $(seq 1 254); do
    if curl -s --connect-timeout 1 "http://${subnet}.${i}:18900/health" 2>/dev/null | grep -q '"status":"ok"'; then
      MASTER_HOST="${subnet}.${i}"
      ok "Znaleziono Master: $MASTER_HOST"
      return 0
    fi &
    [[ $(( i % 30 )) -eq 0 ]] && wait
  done
  wait
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════
#  START
# ═══════════════════════════════════════════════════════════════════════════
clear
echo ""
echo -e "${GREEN}  ╔═══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}     ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗${RESET}     ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}     ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝${RESET}     ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}     ██║███████║██████╔╝██║   ██║██║███████╗${RESET}     ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║${RESET}     ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN}╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║${RESET}     ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}        ${BOLD}${CYAN} ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝${RESET}     ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                     ${DIM}v2.0 // AGENT INSTALLER${RESET}                  ${GREEN}║${RESET}"
echo -e "${GREEN}  ╚═══════════════════════════════════════════════════════════════╝${RESET}"
echo ""

detect_my_ip
echo -e "  ${DIM}Moje IP:    ${MY_IP}${RESET}"
echo -e "  ${DIM}Hostname:   $(hostname)${RESET}"
echo -e "  ${DIM}macOS:      $(sw_vers -productVersion) ($(uname -m))${RESET}"
echo ""

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 1: WYKRYJ MASTERA
# ═════════════════════════════════════════════════════════════════════════
step "1/6  Szukanie Master (Gateway)"

if [[ -z "$MASTER_HOST" ]]; then
  # Probuj wykryc automatycznie
  if ! scan_for_master; then
    echo ""
    echo -e "  ${YELLOW}Nie znaleziono Master automatycznie.${RESET}"
    ask "Wpisz IP komputera Master"
    read -r MASTER_HOST
  fi
fi

# Weryfikuj Master
if curl -s --connect-timeout 3 "http://${MASTER_HOST}:18900/health" 2>/dev/null | grep -q '"status":"ok"'; then
  ok "Master Gateway odpowiada: http://${MASTER_HOST}:18900"

  # Pobierz token z network.json na NAS (jesli dostepny)
  if [[ -z "$AUTH_TOKEN" ]] && [[ -f "$NAS_MOUNT/config/network.json" ]]; then
    AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$NAS_MOUNT/config/network.json')).get('auth_token',''))" 2>/dev/null || echo "")
    [[ -n "$AUTH_TOKEN" ]] && ok "Token pobrany z config sieci"
  fi
else
  warn "Master nie odpowiada na ${MASTER_HOST}:18900"
  warn "Upewnij sie ze Master dziala: ./scripts/jarvis.sh start"
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 2: WYBOR ROLI
# ═════════════════════════════════════════════════════════════════════════
step "2/6  Konfiguracja roli agenta"

if [[ -z "$AGENT_ID" ]]; then
  echo ""
  echo -e "  ${BOLD}Jaka role ma ten komputer?${RESET}"
  echo ""
  echo -e "  ${CYAN}1)${RESET} ${BOLD}ALPHA${RESET} - Developer"
  echo -e "     ${DIM}Kodowanie, React Native, deploy App Store/Google Play,${RESET}"
  echo -e "     ${DIM}web dev, testowanie, DevOps${RESET}"
  echo ""
  echo -e "  ${CYAN}2)${RESET} ${BOLD}BETA${RESET} - Marketing"
  echo -e "     ${DIM}Social media, market research, content marketing,${RESET}"
  echo -e "     ${DIM}PR, analityka, finanse${RESET}"
  echo ""
  ask "Wybierz [1/2]"
  read -r role_choice

  case "${role_choice}" in
    1|alpha|dev)
      AGENT_ID="agent-smith"
      ROLE="dev"
      ;;
    2|beta|marketing)
      AGENT_ID="agent-johny"
      ROLE="marketing"
      ;;
    *)
      AGENT_ID="agent-smith"
      ROLE="dev"
      warn "Domyslnie: Alpha (Dev)"
      ;;
  esac
fi

[[ -z "$ROLE" && "$AGENT_ID" == "agent-smith" ]] && ROLE="dev"
[[ -z "$ROLE" && "$AGENT_ID" == "agent-johny" ]] && ROLE="marketing"

# Websockify port per agent: 6080 alpha, 6081 beta
[[ "$AGENT_ID" == "agent-johny" ]] && WSOCK_PORT=6081 || WSOCK_PORT=6080

ROLE_LABEL=""; [[ "$ROLE" == "dev" ]] && ROLE_LABEL="DEVELOPER" || ROLE_LABEL="MARKETING"

echo ""
ok "Agent: ${AGENT_ID} | Rola: ${ROLE_LABEL}"

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 3: INSTALACJA ZALEZNOSCI
# ═════════════════════════════════════════════════════════════════════════
step "3/6  Instalacja zaleznosci"

# --- Homebrew ---
if check_command brew; then ok "Homebrew"; else
  echo -e "  ${DIM}Instalowanie Homebrew...${RESET}"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)" && echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  ok "Homebrew zainstalowany"
fi

# --- Node.js 22 ---
NODE_V=""; check_command node && NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ -n "$NODE_V" ]] && [[ "$NODE_V" -ge 22 ]]; then ok "Node.js $(node -v)"; else
  echo -e "  ${DIM}Instalowanie Node.js 22...${RESET}"
  brew install node@22; brew link node@22 --overwrite --force 2>/dev/null || true
  NP="$(brew --prefix node@22)/bin"
  echo "$PATH" | grep -q "$NP" || { export PATH="$NP:$PATH"; echo "export PATH=\"$NP:\$PATH\"" >> ~/.zprofile; }
  ok "Node.js $(node -v)"
fi

# --- pnpm ---
check_command pnpm && ok "pnpm" || { npm install -g pnpm; ok "pnpm"; }

# --- Projekt ---
echo -e "  ${DIM}pnpm install...${RESET}"
cd "$JARVIS_DIR" && pnpm install --reporter=silent 2>&1 | tail -1
ok "Zalenosci projektu"

# --- Narzedzia wg roli ---
echo ""
echo -e "  ${BOLD}Narzedzia dla roli ${ROLE_LABEL}:${RESET}"

if [[ "$ROLE" == "dev" ]]; then
  # Playwright
  echo -e "  ${DIM}Instalowanie Playwright + browsers...${RESET}"
  cd "$JARVIS_DIR" && npx playwright install --with-deps 2>/dev/null || npx playwright install 2>/dev/null || true
  ok "Playwright"

  # Xcode CLI
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode CLI Tools"; else
    warn "Xcode CLI Tools - uruchom: xcode-select --install"
  fi

  # Fastlane
  if check_command fastlane; then ok "Fastlane"; else
    echo -e "  ${DIM}Instalowanie Fastlane...${RESET}"
    brew install fastlane 2>/dev/null || warn "Fastlane - zainstaluj recznie: brew install fastlane"
    check_command fastlane && ok "Fastlane"
  fi

elif [[ "$ROLE" == "marketing" ]]; then
  # Playwright
  echo -e "  ${DIM}Instalowanie Playwright + browsers...${RESET}"
  cd "$JARVIS_DIR" && npx playwright install --with-deps 2>/dev/null || npx playwright install 2>/dev/null || true
  ok "Playwright"

  # ffmpeg
  if check_command ffmpeg; then ok "ffmpeg"; else
    echo -e "  ${DIM}Instalowanie ffmpeg...${RESET}"
    brew install ffmpeg; ok "ffmpeg"
  fi

  # ImageMagick
  if check_command magick || check_command convert; then ok "ImageMagick"; else
    echo -e "  ${DIM}Instalowanie ImageMagick...${RESET}"
    brew install imagemagick; ok "ImageMagick"
  fi
fi

# --- Websockify ---
WSOCK_BIN=""
# Szukaj websockify w roznych lokalizacjach
_find_websockify() {
  command -v websockify 2>/dev/null && return
  python3 -c "import shutil; p=shutil.which('websockify'); p and print(p)" 2>/dev/null && return
  for _p in "$HOME"/Library/Python/*/bin/websockify; do
    [[ -x "$_p" ]] && echo "$_p" && return
  done
  [[ -x /opt/homebrew/bin/websockify ]] && echo /opt/homebrew/bin/websockify && return
  echo ""
}

WSOCK_BIN=$(_find_websockify)
if [[ -n "$WSOCK_BIN" ]]; then
  ok "websockify ($WSOCK_BIN)"
else
  echo -e "  ${DIM}Instalowanie websockify...${RESET}"
  pip3 install websockify 2>/dev/null || brew install websockify 2>/dev/null || warn "Zainstaluj websockify recznie"
  # Znajdz binarkę po instalacji
  WSOCK_BIN=$(_find_websockify)
  if [[ -n "$WSOCK_BIN" ]]; then
    ok "websockify zainstalowany ($WSOCK_BIN)"
  else
    warn "websockify zainstalowany ale nie znaleziony w PATH"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 4: NAS MOUNTING
# ═════════════════════════════════════════════════════════════════════════
step "4/6  Konfiguracja storage (NAS)"

if [[ -d "$NAS_MOUNT" ]] && [[ -d "$NAS_MOUNT/sessions" ]]; then
  ok "NAS juz zamontowany: $NAS_MOUNT"
else
  # Sprawdz czy network.json istnieje na NAS (moze NAS jest zamontowany ale bez struktury)
  echo ""
  echo -e "  ${BOLD}Czy NAS jest juz zamontowany na tym komputerze?${RESET}"
  echo -e "  ${DIM}[Y] Tak, w /Volumes/JarvisNAS  |  [IP] Podaj IP NAS  |  [N] Uzyj lokalnego katalogu${RESET}"
  ask "NAS"
  read -r nas_choice

  case "${nas_choice,,}" in
    y|tak)
      NAS_MOUNT="/Volumes/JarvisNAS/jarvis"
      mkdir -p "$NAS_MOUNT"
      if [[ -d "/Volumes/JarvisNAS" ]]; then
        ok "NAS: $NAS_MOUNT"
      else
        warn "/Volumes/JarvisNAS nie istnieje - zamontuj recznie"
      fi
      ;;
    n|nie)
      NAS_MOUNT="$JARVIS_DIR/../jarvis-nas"
      mkdir -p "$NAS_MOUNT"
      ok "Lokalny storage: $NAS_MOUNT"
      ;;
    *)
      # Traktuj jako IP
      local_nas_ip="${nas_choice}"
      ask "Nazwa udzialu SMB (np. jarvis-nas)"
      read -r local_share
      local_share="${local_share:-jarvis-nas}"
      ask "Login NAS"
      read -r local_user
      ask "Haslo NAS (ukryte)"
      read -rs local_pass
      echo ""

      sudo mkdir -p /Volumes/JarvisNAS
      if mount -t smbfs "//${local_user}:${local_pass}@${local_nas_ip}/${local_share}" /Volumes/JarvisNAS 2>/dev/null; then
        NAS_MOUNT="/Volumes/JarvisNAS/jarvis"
        mkdir -p "$NAS_MOUNT"
        ok "NAS zamontowany: $NAS_MOUNT"

        # Auto-mount
        security add-internet-password -a "$local_user" -s "$local_nas_ip" -w "$local_pass" -r "smb " -T /sbin/mount_smbfs 2>/dev/null || true

        AUTOMOUNT_SCRIPT="$JARVIS_DIR/scripts/mount-nas.sh"
        cat > "$AUTOMOUNT_SCRIPT" << 'MNEOF'
#!/usr/bin/env bash
MOUNT_POINT="/Volumes/JarvisNAS"
mount | grep -q "$MOUNT_POINT" && exit 0
mkdir -p "$MOUNT_POINT"
MNEOF
        # Dynamicznie dodaj zmienne
        echo "NAS_IP=\"${local_nas_ip}\"" >> "$AUTOMOUNT_SCRIPT"
        echo "NAS_USER=\"${local_user}\"" >> "$AUTOMOUNT_SCRIPT"
        echo "NAS_SHARE=\"${local_share}\"" >> "$AUTOMOUNT_SCRIPT"
        cat >> "$AUTOMOUNT_SCRIPT" << 'MNEOF2'
NAS_PASS=$(security find-internet-password -a "$NAS_USER" -s "$NAS_IP" -w 2>/dev/null || echo "")
[[ -n "$NAS_PASS" ]] && mount -t smbfs "//${NAS_USER}:${NAS_PASS}@${NAS_IP}/${NAS_SHARE}" "$MOUNT_POINT"
MNEOF2
        chmod +x "$AUTOMOUNT_SCRIPT"

        MOUNT_PLIST="$HOME/Library/LaunchAgents/com.jarvis.nas-mount.plist"
        mkdir -p "$HOME/Library/LaunchAgents"
        cat > "$MOUNT_PLIST" << PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.jarvis.nas-mount</string>
    <key>ProgramArguments</key><array><string>${AUTOMOUNT_SCRIPT}</string></array>
    <key>RunAtLoad</key><true/>
    <key>StartInterval</key><integer>120</integer>
</dict>
</plist>
PEOF
        launchctl load "$MOUNT_PLIST" 2>/dev/null || true
        ok "Auto-mount skonfigurowany"
      else
        warn "Nie udalo sie zamontowac NAS"
        NAS_MOUNT="$JARVIS_DIR/../jarvis-nas"
      fi
      ;;
  esac
fi

# Utworz strukture
for dir in sessions workspace/projects workspace/artifacts knowledge knowledge/entries logs media media/social config; do
  mkdir -p "$NAS_MOUNT/$dir"
done

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 4.5: THUNDERBOLT BRIDGE DETECTION
# ═════════════════════════════════════════════════════════════════════════
echo ""
echo -e "  ${YELLOW}Thunderbolt Bridge Detection...${RESET}"

TB_ENABLED=false
TB_AGENT_IP=""
TB_MASTER_IP="10.0.1.1"
TB_NATS_PORT=4223

# Determine expected TB IP based on role
if [[ "$AGENT_ID" == "agent-smith" ]]; then
  TB_AGENT_IP="10.0.1.2"
else
  TB_AGENT_IP="10.0.1.3"
fi

# Detect Thunderbolt Bridge interface
TB_IFACE=$(networksetup -listallhardwareports 2>/dev/null | grep -A1 "Thunderbolt Bridge" | grep "Device" | awk '{print $2}')

if [[ -n "$TB_IFACE" ]]; then
  ok "Thunderbolt Bridge interface: $TB_IFACE"

  TB_CURRENT_IP=$(ipconfig getifaddr "$TB_IFACE" 2>/dev/null || true)
  if [[ -n "$TB_CURRENT_IP" ]]; then
    ok "Thunderbolt aktywny: $TB_CURRENT_IP"
  fi

  # Check if Master passed TB info or if we can ping Master on TB
  if ping -c 1 -W 1 "$TB_MASTER_IP" &>/dev/null; then
    ok "Master dostepny na Thunderbolt ($TB_MASTER_IP)"
    TB_ENABLED=true

    # Assign our static IP if needed
    if [[ -z "$TB_CURRENT_IP" || "$TB_CURRENT_IP" != "$TB_AGENT_IP" ]]; then
      echo -e "  ${DIM}Przypisywanie IP ${TB_AGENT_IP} do Thunderbolt Bridge...${RESET}"
      networksetup -setmanual "Thunderbolt Bridge" "$TB_AGENT_IP" "255.255.255.0" 2>/dev/null || {
        warn "Nie udalo sie ustawic TB IP - moze wymagac sudo"
      }
    fi

    ok "Thunderbolt Bridge ENABLED ($TB_AGENT_IP -> Master $TB_MASTER_IP)"
  else
    echo -e "  ${DIM}Master niedostepny na TB ($TB_MASTER_IP) - uzywa WiFi/ETH${RESET}"
  fi
else
  echo -e "  ${DIM}Brak interfejsu Thunderbolt Bridge${RESET}"
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 5: KONFIGURACJA (.env + launchd + VNC)
# ═════════════════════════════════════════════════════════════════════════
step "5/6  Konfiguracja agenta"

# .env
ENV_FILE="$JARVIS_DIR/.env"
if [[ ! -f "$ENV_FILE" ]] || ! grep -q "JARVIS_AGENT_ID" "$ENV_FILE" 2>/dev/null; then
  # Jesli nie ma .env lub nie ma AGENT_ID - generuj
  [[ -f "$ENV_FILE" ]] && cp "$ENV_FILE" "$ENV_FILE.backup.$(date +%Y%m%d%H%M%S)"

  MACHINE_ID="$(hostname | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"

  cat > "$ENV_FILE" << ENVEOF
# ═══════════════════════════════════════════════════════════
#  JARVIS 2.0 // AGENT CONFIG (${AGENT_ID})
#  Wygenerowano: $(date)
#  Rola: ${ROLE_LABEL}
# ═══════════════════════════════════════════════════════════

JARVIS_AGENT_ID=${AGENT_ID}
JARVIS_AGENT_ROLE=${ROLE}
JARVIS_MACHINE_ID=${MACHINE_ID}

NATS_URL=nats://${MASTER_HOST}:4222
GATEWAY_URL=http://${MASTER_HOST}:18900
JARVIS_AUTH_TOKEN=${AUTH_TOKEN}
JARVIS_NAS_MOUNT=${NAS_MOUNT}

# Thunderbolt Bridge (10 Gbps)
THUNDERBOLT_ENABLED=${TB_ENABLED}
NATS_URL_THUNDERBOLT=nats://${TB_MASTER_IP}:${TB_NATS_PORT}

# LLM (dodaj klucze lub uzyj Ollama)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_AI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_HOST=http://localhost:11434
ENVEOF

  # Social media keys dla marketingu
  if [[ "$ROLE" == "marketing" ]]; then
    cat >> "$ENV_FILE" << 'SOCIALEOF'

# Social Media APIs
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
META_APP_ID=
META_APP_SECRET=
INSTAGRAM_ACCESS_TOKEN=
FACEBOOK_PAGE_TOKEN=
FACEBOOK_PAGE_ID=
LINKEDIN_ACCESS_TOKEN=
LINKEDIN_PERSON_ID=
TIKTOK_ACCESS_TOKEN=
BRAVE_API_KEY=
PERPLEXITY_API_KEY=
SOCIALEOF
  fi

  ok ".env wygenerowany"
else
  ok ".env juz skonfigurowany"
fi

# --- LaunchAgent: Agent Runtime ---
LAUNCH_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_DIR"

AGENT_PLIST="$LAUNCH_DIR/com.jarvis.${AGENT_ID}.plist"
NODE_BIN="$(which node)"
cat > "$AGENT_PLIST" << PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.jarvis.${AGENT_ID}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>--import</string>
        <string>tsx</string>
        <string>${JARVIS_DIR}/packages/agent-runtime/src/cli.ts</string>
    </array>
    <key>WorkingDirectory</key><string>${JARVIS_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key><string>production</string>
        <key>PATH</key><string>$(dirname "$NODE_BIN"):$(dirname "$(which pnpm)" 2>/dev/null || echo /usr/local/bin):/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><false/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${NAS_MOUNT}/logs/${AGENT_ID}-stdout.log</string>
    <key>StandardErrorPath</key><string>${NAS_MOUNT}/logs/${AGENT_ID}-stderr.log</string>
</dict>
</plist>
PEOF
ok "Agent launchd service"

# --- LaunchAgent: Websockify ---
[[ -z "${WSOCK_BIN:-}" ]] && WSOCK_BIN=$(_find_websockify)
if [[ -n "$WSOCK_BIN" ]]; then
  WSOCK_PLIST="$LAUNCH_DIR/com.jarvis.websockify.plist"
  cat > "$WSOCK_PLIST" << PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.jarvis.websockify</string>
    <key>ProgramArguments</key>
    <array>
        <string>${WSOCK_BIN}</string>
        <string>${WSOCK_PORT}</string>
        <string>localhost:${VNC_PORT}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${NAS_MOUNT}/logs/websockify-stdout.log</string>
    <key>StandardErrorPath</key><string>${NAS_MOUNT}/logs/websockify-stderr.log</string>
</dict>
</plist>
PEOF
  ok "Websockify launchd service (port ${WSOCK_PORT})"
fi

# --- VNC: sprawdz Screen Sharing ---
echo ""
echo -e "  ${BOLD}VNC (Screen Sharing):${RESET}"
if sudo launchctl list 2>/dev/null | grep -q screensharing; then
  ok "Screen Sharing aktywny"
else
  warn "Screen Sharing moze byc wylaczony"
  echo -e "  ${DIM}Wlacz: System Settings -> General -> Sharing -> Screen Sharing${RESET}"

  # Probuj wlaczyc automatycznie
  echo -e "  ${DIM}Probuje wlaczyc automatycznie...${RESET}"
  sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null && ok "Screen Sharing wlaczony automatycznie" || {
    # Fallback: bootstrap system (nowsze macOS)
    sudo launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null && ok "Screen Sharing wlaczony (bootstrap)" || true
  }
fi

# ═════════════════════════════════════════════════════════════════════════
#  FAZA 6: URUCHOMIENIE
# ═════════════════════════════════════════════════════════════════════════
step "6/6  Uruchamianie agenta"

# Websockify
[[ -z "${WSOCK_BIN:-}" ]] && WSOCK_BIN=$(_find_websockify)
if [[ -n "$WSOCK_BIN" ]]; then
  pkill -f "websockify.*${WSOCK_PORT}" 2>/dev/null || true
  sleep 1
  nohup "$WSOCK_BIN" "$WSOCK_PORT" "localhost:${VNC_PORT}" >> "$NAS_MOUNT/logs/websockify.log" 2>&1 &
  sleep 1
  if lsof -i ":${WSOCK_PORT}" -P -n 2>/dev/null | grep -q LISTEN; then
    ok "Websockify dziala (port ${WSOCK_PORT})"
  else
    warn "Websockify nie startowal - uruchom recznie: $WSOCK_BIN ${WSOCK_PORT} localhost:${VNC_PORT}"
  fi
fi

# Agent Runtime
echo -e "  ${DIM}Startowanie Agent Runtime...${RESET}"
cd "$JARVIS_DIR"
TSX_BIN="$JARVIS_DIR/node_modules/.pnpm/node_modules/.bin/tsx"
[[ ! -f "$TSX_BIN" ]] && TSX_BIN="$(which tsx 2>/dev/null || echo "")"

if [[ -n "$TSX_BIN" && -f "$TSX_BIN" ]]; then
  nohup "$TSX_BIN" packages/agent-runtime/src/cli.ts >> "$NAS_MOUNT/logs/${AGENT_ID}.log" 2>&1 &
  echo $! > "/tmp/jarvis-${AGENT_ID}.pid"
  sleep 3
  if kill -0 "$(cat /tmp/jarvis-${AGENT_ID}.pid)" 2>/dev/null; then
    ok "Agent Runtime uruchomiony (PID: $(cat /tmp/jarvis-${AGENT_ID}.pid))"
  else
    warn "Agent Runtime nie uruchomil sie - sprawdz logi: $NAS_MOUNT/logs/${AGENT_ID}.log"
  fi
else
  nohup npx tsx packages/agent-runtime/src/cli.ts >> "$NAS_MOUNT/logs/${AGENT_ID}.log" 2>&1 &
  echo $! > "/tmp/jarvis-${AGENT_ID}.pid"
  ok "Agent Runtime startuje (npx tsx)"
fi

# Test polaczenia z Master
sleep 2
if [[ -n "$MASTER_HOST" ]]; then
  echo ""
  echo -e "  ${DIM}Sprawdzanie polaczenia z Master...${RESET}"
  if curl -s --connect-timeout 3 "http://${MASTER_HOST}:18900/health" 2>/dev/null | grep -q "${AGENT_ID}"; then
    ok "Agent widoczny na Master!"
  else
    warn "Agent jeszcze nie widoczny na Master - moze potrzebowac chwili"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
#  PODSUMOWANIE
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo ""
echo -e "${GREEN}  ╔═══════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   ${BOLD}${CYAN}AGENT ${ROLE_LABEL} ZAINSTALOWANY!${RESET}                          ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ╠═══════════════════════════════════════════════════════════════╣${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Agent ID:   ${BOLD}${AGENT_ID}${RESET}                                  ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Rola:       ${BOLD}${ROLE_LABEL}${RESET}                                   ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Moje IP:    ${MY_IP}                                     ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   Master:     ${MASTER_HOST}                                   ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   VNC:        port ${WSOCK_PORT} (websockify)                       ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   ${DIM}Zarzadzanie: ./scripts/jarvis-agent.sh {start|stop|status}${RESET}${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}   ${DIM}Logi: ${NAS_MOUNT}/logs/${AGENT_ID}.log${RESET}          ${GREEN}║${RESET}"
echo -e "${GREEN}  ║${RESET}                                                             ${GREEN}║${RESET}"
echo -e "${GREEN}  ╚═══════════════════════════════════════════════════════════════╝${RESET}"
echo ""

if [[ "$ROLE" == "marketing" ]]; then
  echo -e "  ${YELLOW}!${RESET} Dodaj klucze Social Media do .env:"
  echo -e "  ${DIM}  nano $ENV_FILE${RESET}"
  echo ""
fi

echo -e "  ${YELLOW}!${RESET} Dodaj przynajmniej jeden klucz API do .env:"
echo -e "  ${DIM}  nano $ENV_FILE${RESET}"
echo ""
