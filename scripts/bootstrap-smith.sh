#!/usr/bin/env bash
###############################################################################
#  JARVIS 2.0 // BOOTSTRAP ALPHA (Mac Mini Agent_Smith)
#
#  Ten skrypt:
#  1. Wlacza SSH (Remote Login)
#  2. Pobiera kod Jarvis z Master po USB-C
#  3. Instaluje Node.js + pnpm + zaleznosci
#  4. Konfiguruje agenta
#  5. Uruchamia agent-runtime + websockify
#
#  URUCHOM NA MAC MINI ALPHA (Agent_Smith):
#    curl -fsSL http://169.254.220.252:9876/bootstrap-smith.sh | bash
###############################################################################

set -euo pipefail

# ─── Kolory ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

MASTER_USB_IP="10.0.1.1"
MASTER_WIFI_IP="192.168.1.33"
MASTER_HTTP_PORT="9876"
JARVIS_DIR="$HOME/Documents/Jarvis-2.0/jarvis"

ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "  ${RED}✗ $1${RESET}"; exit 1; }
step()  { echo -e "\n${CYAN}━━━ $1 ━━━${RESET}"; }

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║${RESET}  ${BOLD}${CYAN}JARVIS 2.0 // ALPHA BOOTSTRAP${RESET}                          ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  ${DIM}Mac Mini Agent_Smith -> Connecting to Master${RESET}             ${GREEN}║${RESET}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${RESET}"
echo ""

# ═══════════════════════════════════════════════════════════════════
#  1. ENABLE SSH (Remote Login)
# ═══════════════════════════════════════════════════════════════════
step "1/7  Wlaczanie SSH (Remote Login)"

if systemsetup -getremotelogin 2>/dev/null | grep -qi "on"; then
  ok "SSH juz wlaczony"
else
  echo -e "  ${DIM}Wlaczanie Remote Login (SSH)...${RESET}"
  echo -e "  ${YELLOW}Moze wymagac hasla administratora:${RESET}"
  sudo systemsetup -setremotelogin on 2>/dev/null && ok "SSH wlaczony!" || {
    # Fallback: launchctl
    sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist 2>/dev/null && ok "SSH wlaczony (launchctl)" || {
      warn "Nie udalo sie wlaczyc SSH automatycznie"
      echo -e "  ${YELLOW}Wlacz recznie: System Settings -> General -> Sharing -> Remote Login${RESET}"
      echo -e "  ${YELLOW}Potem uruchom ten skrypt ponownie${RESET}"
    }
  }
fi

# ═══════════════════════════════════════════════════════════════════
#  2. ENABLE SCREEN SHARING (VNC)
# ═══════════════════════════════════════════════════════════════════
step "2/7  Wlaczanie Screen Sharing (VNC)"

if launchctl list 2>/dev/null | grep -q screensharing; then
  ok "Screen Sharing juz aktywny"
else
  echo -e "  ${DIM}Wlaczanie Screen Sharing...${RESET}"
  sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null && ok "Screen Sharing wlaczony!" || {
    warn "Nie udalo sie wlaczyc automatycznie"
    echo -e "  ${YELLOW}Wlacz: System Settings -> General -> Sharing -> Screen Sharing${RESET}"
  }
fi

# ═══════════════════════════════════════════════════════════════════
#  3. INSTALL HOMEBREW + NODE.JS + PNPM
# ═══════════════════════════════════════════════════════════════════
step "3/7  Instalacja narzedzi"

# Homebrew
if command -v brew &>/dev/null; then
  ok "Homebrew $(brew --version | head -1)"
else
  echo -e "  ${DIM}Instalowanie Homebrew...${RESET}"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  ok "Homebrew zainstalowany"
fi

# Ensure brew is in PATH for this session
[[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"

# Node.js
NODE_V=""
command -v node &>/dev/null && NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
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

# pnpm
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm -v)"
else
  echo -e "  ${DIM}Instalowanie pnpm...${RESET}"
  npm install -g pnpm
  ok "pnpm"
fi

# ═══════════════════════════════════════════════════════════════════
#  4. DOWNLOAD JARVIS CODE FROM MASTER
# ═══════════════════════════════════════════════════════════════════
step "4/7  Pobieranie kodu Jarvis z Master"

mkdir -p "$HOME/Documents/Jarvis-2.0"

ARCHIVE_URL="http://${MASTER_USB_IP}:${MASTER_HTTP_PORT}/jarvis-deploy.tar.gz"
echo -e "  ${DIM}Pobieranie z ${ARCHIVE_URL}...${RESET}"

cd "$HOME/Documents/Jarvis-2.0"

if curl -fsSL "$ARCHIVE_URL" -o jarvis-deploy.tar.gz; then
  ok "Pobrano archiwum"

  # Backup istniejacego katalogu
  [[ -d jarvis ]] && mv jarvis "jarvis.backup.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true

  tar xzf jarvis-deploy.tar.gz
  rm -f jarvis-deploy.tar.gz
  ok "Rozpakowano do $JARVIS_DIR"
else
  # Fallback: WiFi
  warn "USB-C niedostepny, probuje WiFi..."
  ARCHIVE_URL="http://${MASTER_WIFI_IP}:${MASTER_HTTP_PORT}/jarvis-deploy.tar.gz"
  curl -fsSL "$ARCHIVE_URL" -o jarvis-deploy.tar.gz || fail "Nie mozna pobrac kodu!"
  [[ -d jarvis ]] && mv jarvis "jarvis.backup.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  tar xzf jarvis-deploy.tar.gz
  rm -f jarvis-deploy.tar.gz
  ok "Rozpakowano (WiFi)"
fi

# ═══════════════════════════════════════════════════════════════════
#  5. INSTALL DEPENDENCIES
# ═══════════════════════════════════════════════════════════════════
step "5/7  Instalacja zaleznosci"

cd "$JARVIS_DIR"
echo -e "  ${DIM}pnpm install...${RESET}"
pnpm install 2>&1 | tail -5
ok "Zaleznosci zainstalowane"

# Playwright browsers
echo -e "  ${DIM}Playwright browsers...${RESET}"
npx playwright install chromium 2>/dev/null || warn "Playwright - zainstaluj pozniej: npx playwright install"

# Websockify
if command -v websockify &>/dev/null; then
  ok "websockify"
else
  echo -e "  ${DIM}Instalowanie websockify...${RESET}"
  pip3 install websockify 2>/dev/null || brew install websockify 2>/dev/null || warn "Zainstaluj recznie: pip3 install websockify"
fi

# ═══════════════════════════════════════════════════════════════════
#  6. GENERATE .env
# ═══════════════════════════════════════════════════════════════════
step "6/7  Konfiguracja .env"

MY_USB_IP=$(ifconfig 2>/dev/null | grep -A5 'en1[0-9]' | grep 'inet 169.254' | head -1 | awk '{print $2}')
[[ -z "$MY_USB_IP" ]] && MY_USB_IP=$(arp -a | grep "169.254" | head -1 | grep -oE '169\.254\.[0-9]+\.[0-9]+' | head -1)
MY_WIFI_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "")

cat > "$JARVIS_DIR/.env" << ENVEOF
# ═══════════════════════════════════════════════════════════
#  JARVIS 2.0 // AGENT ALPHA CONFIG
#  Wygenerowano: $(date)
#  Rola: DEVELOPER
# ═══════════════════════════════════════════════════════════

# Agent Identity
JARVIS_AGENT_ID=agent-smith
JARVIS_AGENT_ROLE=dev
JARVIS_MACHINE_ID=mac-mini-alpha

# NATS (Master connection)
NATS_URL=nats://${MASTER_WIFI_IP}:4222

# Gateway
GATEWAY_URL=http://${MASTER_WIFI_IP}:18900
JARVIS_AUTH_TOKEN=jarvis-dev-token-2024

# NAS Mount (stworz katalog lokalnie na testy)
JARVIS_NAS_MOUNT=$JARVIS_DIR/../jarvis-nas

# Thunderbolt 5 Direct Link (120 Gbps)
# Master: 10.0.1.1 <-> Smith: 10.0.1.2
THUNDERBOLT_ENABLED=true
NATS_URL_THUNDERBOLT=nats://10.0.1.1:4223
MASTER_IP_THUNDERBOLT=10.0.1.1
ALPHA_IP_THUNDERBOLT=10.0.1.2

# LLM Providers (klucze z Master - uzywaj te same)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_AI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_HOST=http://localhost:11434
ENVEOF

ok ".env wygenerowany"
echo -e "  ${YELLOW}!${RESET} ${BOLD}Dodaj klucze API do .env:${RESET}"
echo -e "  ${DIM}  nano $JARVIS_DIR/.env${RESET}"

# Create NAS dir locally
mkdir -p "$JARVIS_DIR/../jarvis-nas"/{sessions,workspace/projects,workspace/artifacts,knowledge,logs,media,config}
ok "Lokalny storage utworzony"

# ═══════════════════════════════════════════════════════════════════
#  7. START SERVICES
# ═══════════════════════════════════════════════════════════════════
step "7/7  Uruchamianie uslug"

# Websockify (VNC proxy)
if command -v websockify &>/dev/null; then
  pkill -f "websockify.*6080" 2>/dev/null || true
  sleep 1
  nohup websockify 6080 localhost:5900 >> /tmp/jarvis-websockify.log 2>&1 &
  sleep 1
  if lsof -i :6080 -P -n 2>/dev/null | grep -q LISTEN; then
    ok "Websockify dziala (port 6080)"
  else
    warn "Websockify - uruchom recznie: websockify 6080 localhost:5900"
  fi
fi

# Agent Runtime
echo -e "  ${DIM}Startowanie Agent Runtime...${RESET}"
cd "$JARVIS_DIR"

# Find tsx
TSX_BIN="$JARVIS_DIR/node_modules/.pnpm/node_modules/.bin/tsx"
[[ ! -f "$TSX_BIN" ]] && TSX_BIN="$(command -v tsx 2>/dev/null || echo "")"
[[ ! -f "$TSX_BIN" ]] && TSX_BIN="$(npm root -g 2>/dev/null)/tsx/dist/cli.mjs"

if [[ -n "$TSX_BIN" && -f "$TSX_BIN" ]]; then
  nohup "$TSX_BIN" packages/agent-runtime/src/cli.ts >> /tmp/jarvis-agent-smith.log 2>&1 &
  AGENT_PID=$!
  echo $AGENT_PID > /tmp/jarvis-agent-smith.pid
  sleep 3
  if kill -0 "$AGENT_PID" 2>/dev/null; then
    ok "Agent Runtime uruchomiony (PID: $AGENT_PID)"
  else
    warn "Agent nie startowal - sprawdz: tail -50 /tmp/jarvis-agent-smith.log"
  fi
else
  nohup npx tsx packages/agent-runtime/src/cli.ts >> /tmp/jarvis-agent-smith.log 2>&1 &
  ok "Agent Runtime startuje (npx tsx)"
fi

# ═══════════════════════════════════════════════════════════════════
#  PODSUMOWANIE
# ═══════════════════════════════════════════════════════════════════
echo ""
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║${RESET}                                                         ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  ${BOLD}${CYAN}✓ AGENT ALPHA (DEV) ZAINSTALOWANY!${RESET}                     ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}                                                         ${GREEN}║${RESET}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════════╣${RESET}"
echo -e "${GREEN}║${RESET}                                                         ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  Agent ID:    agent-smith                                ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  Rola:        DEVELOPER                                  ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  WiFi IP:     ${MY_WIFI_IP:-?}                                  ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  USB-C IP:    ${MY_USB_IP:-?}                             ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  Master:      ${MASTER_USB_IP} (USB-C)                    ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  NATS:        ${MASTER_USB_IP}:4222 (USB-C priority)      ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  VNC Proxy:   port 6080                                  ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}                                                         ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  ${DIM}Logi:  tail -f /tmp/jarvis-agent-smith.log${RESET}            ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}  ${DIM}Stop:  kill \$(cat /tmp/jarvis-agent-smith.pid)${RESET}        ${GREEN}║${RESET}"
echo -e "${GREEN}║${RESET}                                                         ${GREEN}║${RESET}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${YELLOW}NASTEPNE KROKI:${RESET}"
echo -e "  ${DIM}1. Dodaj klucze API: nano $JARVIS_DIR/.env${RESET}"
echo -e "  ${DIM}2. Otworz dashboard: http://${MASTER_WIFI_IP}:18900${RESET}"
echo -e "  ${DIM}3. Powinienes widziec agenta w Dashboard!${RESET}"
echo ""
