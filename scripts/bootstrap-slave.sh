#!/usr/bin/env bash
###############################################################################
#  JARVIS 2.0 // BOOTSTRAP SLAVE (Mac Mini Agent)
#
#  Uniwersalny instalator dla ALPHA i BETA.
#  Automatycznie wykrywa Master i konfiguruje agenta.
#
#  URUCHOM NA MAC MINI SLAVE:
#    curl -fsSL http://MASTER_IP:9876/bootstrap-slave.sh | bash
#
#  Lub skopiuj i uruchom:
#    bash bootstrap-slave.sh
###############################################################################

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

JARVIS_DIR="$HOME/Documents/Jarvis-2.0/jarvis"
MASTER_HTTP_PORT="9876"
GATEWAY_PORT="18900"

ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "  ${RED}✗ $1${RESET}"; }
step()  { echo -e "\n${CYAN}━━━ $1 ━━━${RESET}"; }

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║${RESET}  ${BOLD}${CYAN}JARVIS 2.0 // SLAVE BOOTSTRAP${RESET}                           ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  ${DIM}Instalator agenta dla Mac Mini${RESET}                           ${GREEN}║${RESET}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${RESET}"
echo ""

# ═══════════════════════════════════════════════════════════════════
#  1. DETECT MASTER
# ═══════════════════════════════════════════════════════════════════
step "1/8  Wykrywanie Master"

MASTER_IP=""
MY_WIFI_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
MY_USB_IP=""

# Check all interfaces for Thunderbolt (static 10.0.1.x or legacy link-local 169.254.x.x)
for iface in bridge0 en5 en6 en7 en8 en9 en10 en11 en12; do
  ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
  if [[ "$ip" == 10.0.1.* || "$ip" == 169.254.* ]]; then
    MY_USB_IP="$ip"
    ok "Thunderbolt interface: $iface ($ip)"
    break
  fi
done

# Try to find Master on Thunderbolt first (faster)
if [[ -n "$MY_USB_IP" ]]; then
  echo -e "  ${DIM}Szukam Master na Thunderbolt...${RESET}"
  # Try static TB5 master IP first
  if curl -s --connect-timeout 2 "http://10.0.1.1:${GATEWAY_PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; then
    MASTER_IP="10.0.1.1"
    ok "Master znaleziony na Thunderbolt 5: $MASTER_IP"
  else
    # Fallback: scan ARP table for legacy link-local
    for host in $(arp -a 2>/dev/null | grep -oE '169\.254\.[0-9]+\.[0-9]+'); do
      if curl -s --connect-timeout 2 "http://${host}:${GATEWAY_PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; then
        MASTER_IP="$host"
        ok "Master znaleziony na Thunderbolt (legacy): $MASTER_IP"
        break
      fi
    done
  fi
fi

# Fallback: find Master on WiFi
if [[ -z "$MASTER_IP" && -n "$MY_WIFI_IP" ]]; then
  echo -e "  ${DIM}Szukam Master na WiFi...${RESET}"
  SUBNET=$(echo "$MY_WIFI_IP" | sed 's/\.[0-9]*$//')
  for i in $(seq 1 254); do
    if curl -s --connect-timeout 1 "http://${SUBNET}.${i}:${GATEWAY_PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; then
      MASTER_IP="${SUBNET}.${i}"
      ok "Master znaleziony na WiFi: $MASTER_IP"
      break
    fi &
    [[ $(( i % 40 )) -eq 0 ]] && wait
  done
  wait
fi

# Manual entry if not found
if [[ -z "$MASTER_IP" ]]; then
  echo -e "  ${YELLOW}Nie znaleziono Master automatycznie.${RESET}"
  echo -ne "  ${BOLD}Wpisz IP Master: ${RESET}"
  read -r MASTER_IP
fi

if [[ -z "$MASTER_IP" ]]; then
  fail "Brak IP Master. Upewnij sie ze Master dziala."
  exit 1
fi

# Find Master Thunderbolt IP (for fast NATS)
MASTER_USB_IP=""
if [[ -n "$MY_USB_IP" ]]; then
  # Try static TB5 master first
  if nc -z -w 1 "10.0.1.1" 4222 2>/dev/null; then
    MASTER_USB_IP="10.0.1.1"
    ok "Master Thunderbolt NATS: 10.0.1.1:4222"
  else
    # Fallback: scan ARP for legacy link-local
    for host in $(arp -a 2>/dev/null | grep -oE '169\.254\.[0-9]+\.[0-9]+'); do
      if [[ "$host" != "$MY_USB_IP" ]]; then
        if nc -z -w 1 "$host" 4222 2>/dev/null; then
          MASTER_USB_IP="$host"
          ok "Master USB-C NATS: $host:4222"
          break
        fi
      fi
    done
  fi
fi

# ═══════════════════════════════════════════════════════════════════
#  2. CHOOSE ROLE
# ═══════════════════════════════════════════════════════════════════
step "2/8  Wybor roli"

echo ""
echo -e "  ${BOLD}Jaka role ma ten komputer?${RESET}"
echo ""
echo -e "  ${CYAN}1)${RESET} ${BOLD}ALPHA${RESET} - Developer"
echo -e "     ${DIM}Kodowanie, web dev, testowanie, DevOps${RESET}"
echo ""
echo -e "  ${CYAN}2)${RESET} ${BOLD}BETA${RESET} - Marketing"
echo -e "     ${DIM}Social media, research, content, analityka${RESET}"
echo ""
echo -ne "  Wybierz [1/2]: "
read -r role_choice

case "${role_choice}" in
  1|alpha|dev)
    AGENT_ID="agent-smith"
    ROLE="dev"
    ROLE_LABEL="DEVELOPER"
    ;;
  2|beta|marketing)
    AGENT_ID="agent-johny"
    ROLE="marketing"
    ROLE_LABEL="MARKETING"
    ;;
  *)
    AGENT_ID="agent-smith"
    ROLE="dev"
    ROLE_LABEL="DEVELOPER"
    warn "Domyslnie: Alpha (Dev)"
    ;;
esac

ok "Agent: ${AGENT_ID} | Rola: ${ROLE_LABEL}"

# ═══════════════════════════════════════════════════════════════════
#  3. ENABLE SSH & SCREEN SHARING
# ═══════════════════════════════════════════════════════════════════
step "3/8  Wlaczanie uslug zdalnych"

# SSH
if systemsetup -getremotelogin 2>/dev/null | grep -qi "on"; then
  ok "SSH (Remote Login) aktywny"
else
  echo -e "  ${DIM}Wlaczanie SSH...${RESET}"
  sudo systemsetup -setremotelogin on 2>/dev/null && ok "SSH wlaczony" || {
    sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist 2>/dev/null && ok "SSH wlaczony" || {
      warn "Wlacz recznie: System Settings -> Sharing -> Remote Login"
    }
  }
fi

# Screen Sharing
if launchctl list 2>/dev/null | grep -q screensharing; then
  ok "Screen Sharing aktywny"
else
  echo -e "  ${DIM}Wlaczanie Screen Sharing...${RESET}"
  sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null && ok "Screen Sharing wlaczony" || {
    warn "Wlacz recznie: System Settings -> Sharing -> Screen Sharing"
  }
fi

# ═══════════════════════════════════════════════════════════════════
#  4. INSTALL TOOLS
# ═══════════════════════════════════════════════════════════════════
step "4/8  Instalacja narzedzi"

# Homebrew
if command -v brew &>/dev/null; then
  ok "Homebrew"
else
  echo -e "  ${DIM}Instalowanie Homebrew...${RESET}"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  ok "Homebrew"
fi
[[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"

# Node.js
NODE_V=""
command -v node &>/dev/null && NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ -n "$NODE_V" ]] && [[ "$NODE_V" -ge 20 ]]; then
  ok "Node.js $(node -v)"
else
  echo -e "  ${DIM}Instalowanie Node.js...${RESET}"
  brew install node@22 && brew link node@22 --overwrite --force 2>/dev/null || brew install node
  ok "Node.js $(node -v)"
fi

# pnpm
if command -v pnpm &>/dev/null; then ok "pnpm"; else npm install -g pnpm && ok "pnpm"; fi

# ═══════════════════════════════════════════════════════════════════
#  5. DOWNLOAD JARVIS
# ═══════════════════════════════════════════════════════════════════
step "5/8  Pobieranie kodu Jarvis"

mkdir -p "$HOME/Documents/Jarvis-2.0"
cd "$HOME/Documents/Jarvis-2.0"

DOWNLOAD_OK=false

# Try USB-C first
if [[ -n "$MASTER_USB_IP" ]]; then
  echo -e "  ${DIM}Pobieranie po USB-C ($MASTER_USB_IP)...${RESET}"
  if curl -fsSL "http://${MASTER_USB_IP}:${MASTER_HTTP_PORT}/jarvis-deploy.tar.gz" -o jarvis-deploy.tar.gz 2>/dev/null; then
    DOWNLOAD_OK=true
    ok "Pobrano po USB-C"
  fi
fi

# Fallback: WiFi
if [[ "$DOWNLOAD_OK" != "true" ]]; then
  echo -e "  ${DIM}Pobieranie po WiFi ($MASTER_IP)...${RESET}"
  if curl -fsSL "http://${MASTER_IP}:${MASTER_HTTP_PORT}/jarvis-deploy.tar.gz" -o jarvis-deploy.tar.gz 2>/dev/null; then
    DOWNLOAD_OK=true
    ok "Pobrano po WiFi"
  fi
fi

if [[ "$DOWNLOAD_OK" != "true" ]]; then
  fail "Nie mozna pobrac kodu. Upewnij sie ze HTTP server dziala na Master."
  exit 1
fi

# Extract
[[ -d jarvis ]] && mv jarvis "jarvis.bak.$(date +%s)" 2>/dev/null || true
tar xzf jarvis-deploy.tar.gz
rm -f jarvis-deploy.tar.gz
ok "Rozpakowano do $JARVIS_DIR"

# ═══════════════════════════════════════════════════════════════════
#  6. INSTALL DEPENDENCIES
# ═══════════════════════════════════════════════════════════════════
step "6/8  Instalacja zaleznosci"

cd "$JARVIS_DIR"
echo -e "  ${DIM}pnpm install...${RESET}"
pnpm install 2>&1 | tail -3
ok "Zaleznosci"

# Websockify
if command -v websockify &>/dev/null; then
  ok "websockify"
else
  echo -e "  ${DIM}Instalowanie websockify...${RESET}"
  pip3 install websockify 2>/dev/null || brew install websockify 2>/dev/null || warn "Zainstaluj: pip3 install websockify"
fi

# ═══════════════════════════════════════════════════════════════════
#  7. GENERATE .env
# ═══════════════════════════════════════════════════════════════════
step "7/8  Generowanie .env"

MACHINE_ID="$(hostname | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"

# Determine NATS URL priority: USB-C (fast) then WiFi (fallback)
NATS_PRIMARY="nats://${MASTER_IP}:4222"
NATS_THUNDERBOLT=""
if [[ -n "$MASTER_USB_IP" ]]; then
  NATS_THUNDERBOLT="nats://${MASTER_USB_IP}:4222"
fi

cat > "$JARVIS_DIR/.env" << ENVEOF
# ═══════════════════════════════════════════════════════
#  JARVIS 2.0 // ${AGENT_ID^^} (${ROLE_LABEL})
#  Generated: $(date)
#  Machine: ${MACHINE_ID}
# ═══════════════════════════════════════════════════════

# Agent Identity
JARVIS_AGENT_ID=${AGENT_ID}
JARVIS_AGENT_ROLE=${ROLE}
JARVIS_MACHINE_ID=${MACHINE_ID}

# NATS (Master)
NATS_URL=${NATS_PRIMARY}

# Gateway
GATEWAY_URL=http://${MASTER_IP}:${GATEWAY_PORT}
JARVIS_AUTH_TOKEN=jarvis-dev-token-2024

# Storage (local)
JARVIS_NAS_MOUNT=${JARVIS_DIR}/../jarvis-nas

# USB-C Direct Link
THUNDERBOLT_ENABLED=${MASTER_USB_IP:+true}
NATS_URL_THUNDERBOLT=${NATS_THUNDERBOLT}
MASTER_IP_THUNDERBOLT=${MASTER_USB_IP}

# LLM API Keys (skopiuj z Master lub dodaj swoje)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_AI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_HOST=http://127.0.0.1:11434
ENVEOF

ok ".env wygenerowany"

# Create storage dirs
mkdir -p "$JARVIS_DIR/../jarvis-nas"/{sessions,workspace/projects,workspace/artifacts,knowledge,logs,media,config}
ok "Storage lokalny"

# ═══════════════════════════════════════════════════════════════════
#  8. START SERVICES
# ═══════════════════════════════════════════════════════════════════
step "8/8  Uruchamianie"

# Websockify port per agent: 6080 alpha, 6081 beta
if [[ "$AGENT_ID" == "agent-johny" ]]; then
  WSOCK_PORT=6081
else
  WSOCK_PORT=6080
fi

# Websockify (VNC proxy: $WSOCK_PORT -> 5900)
# Szukaj websockify binarki (pip3 moze zainstalowac poza PATH)
_find_wsock() {
  command -v websockify 2>/dev/null && return
  python3 -c "import shutil; p=shutil.which('websockify'); p and print(p)" 2>/dev/null && return
  for _p in "$HOME"/Library/Python/*/bin/websockify; do [[ -x "$_p" ]] && echo "$_p" && return; done
  echo ""
}
WSOCK_BIN=$(_find_wsock)

if [[ -n "$WSOCK_BIN" ]]; then
  pkill -f "websockify.*${WSOCK_PORT}" 2>/dev/null || true
  sleep 1
  nohup "$WSOCK_BIN" "$WSOCK_PORT" localhost:5900 >> /tmp/jarvis-websockify.log 2>&1 &
  sleep 1
  if lsof -i ":${WSOCK_PORT}" -P -n 2>/dev/null | grep -q LISTEN; then
    ok "Websockify (port ${WSOCK_PORT} -> VNC 5900)"
  else
    warn "Websockify nie startowal. Uruchom: $WSOCK_BIN ${WSOCK_PORT} localhost:5900"
  fi
else
  warn "Brak websockify - zainstaluj: pip3 install websockify"
fi

# Agent Runtime
echo -e "  ${DIM}Startowanie Agent Runtime...${RESET}"
cd "$JARVIS_DIR"

TSX_BIN="$JARVIS_DIR/node_modules/.pnpm/node_modules/.bin/tsx"
[[ ! -f "$TSX_BIN" ]] && TSX_BIN="$(command -v tsx 2>/dev/null || echo "")"

if [[ -n "$TSX_BIN" && -f "$TSX_BIN" ]]; then
  nohup "$TSX_BIN" packages/agent-runtime/src/cli.ts >> /tmp/jarvis-${AGENT_ID}.log 2>&1 &
  AGENT_PID=$!
else
  nohup npx tsx packages/agent-runtime/src/cli.ts >> /tmp/jarvis-${AGENT_ID}.log 2>&1 &
  AGENT_PID=$!
fi

echo $AGENT_PID > /tmp/jarvis-${AGENT_ID}.pid
sleep 3

if kill -0 "$AGENT_PID" 2>/dev/null; then
  ok "Agent Runtime (PID: $AGENT_PID)"
else
  warn "Agent moze nie wystartowac - sprawdz: tail -20 /tmp/jarvis-${AGENT_ID}.log"
fi

# ═══════════════════════════════════════════════════════════════════
#  SUMMARY
# ═══════════════════════════════════════════════════════════════════
echo ""
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║${RESET}  ${BOLD}${CYAN}AGENT ${ROLE_LABEL} ZAINSTALOWANY!${RESET}                          ${GREEN}║${RESET}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════════╣${RESET}"
echo -e "${GREEN}║${RESET}  Agent:    ${BOLD}${AGENT_ID}${RESET}                                  ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  Rola:     ${BOLD}${ROLE_LABEL}${RESET}                                   ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  WiFi:     ${MY_WIFI_IP:-brak}                                     ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  USB-C:    ${MY_USB_IP:-brak}                                  ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  Master:   ${MASTER_IP}                                   ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  NATS:     ${NATS_PRIMARY}                      ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  VNC:      port ${WSOCK_PORT}                                     ${GREEN}║${RESET}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${YELLOW}CO DALEJ:${RESET}"
echo -e "  ${DIM}1. Dodaj klucze API: nano $JARVIS_DIR/.env${RESET}"
echo -e "  ${DIM}2. Dashboard: http://${MASTER_IP}:${GATEWAY_PORT}${RESET}"
echo -e "  ${DIM}3. Logi: tail -f /tmp/jarvis-${AGENT_ID}.log${RESET}"
echo -e "  ${DIM}4. Stop: kill \$(cat /tmp/jarvis-${AGENT_ID}.pid)${RESET}"
echo ""
