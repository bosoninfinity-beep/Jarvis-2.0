#!/usr/bin/env bash
###############################################################################
#  JARVIS 2.0 // OTA UPDATE TRAMPOLINE
#  Spawned by gateway as a detached process. Does git pull → build → restart.
#  Gateway can't restart itself (it'd die mid-restart), so this script outlives it.
###############################################################################

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JARVIS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOCK_FILE="/tmp/jarvis-update.lock"
STATUS_FILE="/tmp/jarvis-update-status.json"
LOG_FILE="/tmp/jarvis-update.log"

# ─── Helpers ─────────────────────────────────────────────────────────────────

write_status() {
  local status="$1"
  local message="$2"
  local prev_head="${3:-}"
  local new_head="${4:-}"
  cat > "$STATUS_FILE" <<STATUSEOF
{
  "status": "$status",
  "message": "$message",
  "prevHead": "$prev_head",
  "newHead": "$new_head",
  "timestamp": $(date +%s)000
}
STATUSEOF
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# ─── Lock ────────────────────────────────────────────────────────────────────

if [[ -f "$LOCK_FILE" ]]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "ERROR: Another update is already running (PID $LOCK_PID)"
    write_status "error" "Another update is already running" "" ""
    exit 1
  fi
  # Stale lock — remove it
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ─── Begin Update ────────────────────────────────────────────────────────────

cd "$JARVIS_DIR"

log "=== JARVIS OTA UPDATE STARTED ==="
write_status "running" "Starting update..." "" ""

# Save current HEAD
PREV_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "Current HEAD: $PREV_HEAD"

# ─── Git Pull ────────────────────────────────────────────────────────────────

log "Running git pull..."
if ! git pull --ff-only 2>&1 | tee -a "$LOG_FILE"; then
  log "ERROR: git pull failed — no code changed"
  write_status "error" "git pull failed — no code changed" "$PREV_HEAD" "$PREV_HEAD"
  exit 1
fi

NEW_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "New HEAD: $NEW_HEAD"

if [[ "$PREV_HEAD" == "$NEW_HEAD" ]]; then
  log "Already up to date — no changes pulled"
  write_status "done" "Already up to date" "$PREV_HEAD" "$NEW_HEAD"
  # Still restart to pick up any pending changes
fi

# ─── Install Dependencies ────────────────────────────────────────────────────

log "Running pnpm install..."
write_status "running" "Installing dependencies..." "$PREV_HEAD" "$NEW_HEAD"
if ! pnpm install --frozen-lockfile 2>&1 | tee -a "$LOG_FILE"; then
  log "WARN: pnpm install --frozen-lockfile failed, trying without flag..."
  if ! pnpm install 2>&1 | tee -a "$LOG_FILE"; then
    log "ERROR: pnpm install failed — rolling back"
    git reset --hard "$PREV_HEAD" 2>&1 | tee -a "$LOG_FILE"
    write_status "error" "pnpm install failed — rolled back to previous version" "$PREV_HEAD" "$PREV_HEAD"
    # Restart with old code anyway
    "$SCRIPT_DIR/jarvis.sh" restart >> "$LOG_FILE" 2>&1 || true
    exit 1
  fi
fi

# ─── Build ───────────────────────────────────────────────────────────────────

log "Running pnpm build..."
write_status "running" "Building..." "$PREV_HEAD" "$NEW_HEAD"
if ! pnpm build 2>&1 | tee -a "$LOG_FILE"; then
  log "ERROR: Build failed — rolling back to $PREV_HEAD"
  write_status "running" "Build failed — rolling back..." "$PREV_HEAD" "$NEW_HEAD"

  # Rollback
  git reset --hard "$PREV_HEAD" 2>&1 | tee -a "$LOG_FILE"
  pnpm install 2>&1 | tee -a "$LOG_FILE" || true
  pnpm build 2>&1 | tee -a "$LOG_FILE" || true

  write_status "error" "Build failed — rolled back to previous version" "$PREV_HEAD" "$PREV_HEAD"

  # Restart with old code
  log "Restarting with previous version..."
  "$SCRIPT_DIR/jarvis.sh" restart >> "$LOG_FILE" 2>&1 || true
  exit 1
fi

# ─── Sync to Remote Agents ───────────────────────────────────────────────────

SSH_KEY="$HOME/.ssh/id_ed25519"
if [[ -f "$SSH_KEY" ]]; then
  log "Syncing updated code to remote agents..."
  write_status "running" "Syncing to remote agents..." "$PREV_HEAD" "$NEW_HEAD"

  # Load env for agent IPs
  [[ -f "$JARVIS_DIR/.env" ]] && set -a && source "$JARVIS_DIR/.env" && set +a
  SMITH_IP="${SMITH_IP:-${ALPHA_IP:-192.168.1.37}}"
  SMITH_USER="${SMITH_USER:-${ALPHA_USER:-agent_smith}}"
  JOHNY_IP="${JOHNY_IP:-${BETA_IP:-192.168.1.253}}"
  JOHNY_USER="${JOHNY_USER:-${BETA_USER:-kamilpadula}}"

  for AGENT_USER_HOST in "${SMITH_USER}@${SMITH_IP}" "${JOHNY_USER}@${JOHNY_IP}"; do
    AGENT_USER="${AGENT_USER_HOST%%@*}"
    AGENT_HOST="${AGENT_USER_HOST##*@}"
    log "Syncing to $AGENT_USER_HOST..."

    SSH_ARGS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

    for PKG in shared agent-runtime tools; do
      rsync -avz --delete -e "ssh $SSH_ARGS" \
        "$JARVIS_DIR/packages/$PKG/" \
        "$AGENT_USER_HOST:~/jarvis/packages/$PKG/" 2>&1 | tee -a "$LOG_FILE" || true
    done

    # Sync root config files
    for F in package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json force-ipv4.cjs; do
      [[ -f "$JARVIS_DIR/$F" ]] && rsync -avz -e "ssh $SSH_ARGS" \
        "$JARVIS_DIR/$F" "$AGENT_USER_HOST:~/jarvis/$F" 2>&1 | tee -a "$LOG_FILE" || true
    done

    # pnpm install + build on remote
    ssh $SSH_ARGS "$AGENT_USER_HOST" \
      "source ~/.zshrc 2>/dev/null; cd ~/jarvis && pnpm install --frozen-lockfile && pnpm build" \
      2>&1 | tee -a "$LOG_FILE" || log "WARN: Remote build failed on $AGENT_HOST"

    # Restart agent via launchctl
    AGENT_ID="agent-${AGENT_USER#agent_}"
    ssh $SSH_ARGS "$AGENT_USER_HOST" \
      "launchctl bootout gui/\$(id -u)/com.jarvis.$AGENT_ID 2>/dev/null; sleep 1; launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.jarvis.$AGENT_ID.plist 2>/dev/null; true" \
      2>&1 | tee -a "$LOG_FILE" || true

    log "Agent $AGENT_ID synced and restarted"
  done
else
  log "WARN: SSH key not found, skipping remote agent sync"
fi

# ─── Rebuild Desktop App ────────────────────────────────────────────────────

DESKTOP_DIR="$JARVIS_DIR/packages/desktop"
if [[ -f "$DESKTOP_DIR/build-full.sh" ]]; then
  log "Rebuilding desktop app..."
  write_status "running" "Rebuilding desktop app..." "$PREV_HEAD" "$NEW_HEAD"
  if bash "$DESKTOP_DIR/build-full.sh" 2>&1 | tee -a "$LOG_FILE"; then
    log "Installing updated app to /Applications..."
    osascript -e 'tell application "Jarvis 2.0" to quit' 2>/dev/null || true
    sleep 2
    rm -rf "/Applications/Jarvis 2.0.app"
    cp -r "$DESKTOP_DIR/Jarvis 2.0.app" /Applications/
    log "Desktop app updated and installed"
  else
    log "WARN: Desktop app rebuild failed, skipping"
  fi
fi

# ─── Restart ─────────────────────────────────────────────────────────────────

log "Update successful. Restarting Jarvis..."
write_status "done" "Update complete" "$PREV_HEAD" "$NEW_HEAD"

# Small delay to let gateway read status before dying
sleep 1

# If desktop app is installed, reopen it (it bundles gateway/NATS/Redis)
if [[ -d "/Applications/Jarvis 2.0.app" ]]; then
  log "Reopening desktop app..."
  open "/Applications/Jarvis 2.0.app" 2>&1 | tee -a "$LOG_FILE" || true
else
  # Fallback: standalone mode
  "$SCRIPT_DIR/jarvis.sh" restart >> "$LOG_FILE" 2>&1 || true
fi

log "=== JARVIS OTA UPDATE COMPLETED ==="
