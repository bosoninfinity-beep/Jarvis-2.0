#!/bin/bash
# Sync Claude OAuth token from Mac Studio Keychain to agents
# Run via cron every 30 min

TOKEN=$(security find-generic-password -s "Claude Code-credentials" -a "jarvis" -w 2>/dev/null)
if [ -z "$TOKEN" ] || [ ${#TOKEN} -lt 50 ]; then
  exit 1
fi

# Write to NAS (delete then create to avoid SMB overwrite bug)
NAS_FILE="/Volumes/Public/jarvis-nas/config/claude-oauth.json"
if [ -d "/Volumes/Public/jarvis-nas/config" ]; then
  rm -f "$NAS_FILE" 2>/dev/null
  printf '%s' "$TOKEN" > "$NAS_FILE" 2>/dev/null
fi

# Write token to temp file, scp to agents, then inject via SSH
TMPFILE="/tmp/.claude-token-sync"
printf '%s' "$TOKEN" > "$TMPFILE"

# Smith — login keychain, password 137009
scp -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$TMPFILE" agent_smith@192.168.1.37:/tmp/.claude-token-sync 2>/dev/null
sshpass -p '137009' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 agent_smith@192.168.1.37 '
  security unlock-keychain -p "137009" ~/Library/Keychains/login.keychain-db 2>/dev/null
  TK=$(cat /tmp/.claude-token-sync)
  security delete-generic-password -s "Claude Code-credentials" -a "agent_smith" ~/Library/Keychains/login.keychain-db 2>/dev/null
  security add-generic-password -A -s "Claude Code-credentials" -a "agent_smith" -w "$TK" ~/Library/Keychains/login.keychain-db 2>/dev/null
  rm -f /tmp/.claude-token-sync
' 2>/dev/null

# Johny — claude keychain, keychain password !TwojaStara!0, SSH password 137009
scp -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$TMPFILE" kamilpadula@192.168.1.253:/tmp/.claude-token-sync 2>/dev/null
sshpass -p '137009' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 kamilpadula@192.168.1.253 '
  KCP="!TwojaStara!0"
  security unlock-keychain -p "$KCP" ~/Library/Keychains/claude.keychain-db 2>/dev/null
  TK=$(cat /tmp/.claude-token-sync)
  security delete-generic-password -s "Claude Code-credentials" -a "kamilpadula" ~/Library/Keychains/claude.keychain-db 2>/dev/null
  security add-generic-password -A -s "Claude Code-credentials" -a "kamilpadula" -w "$TK" ~/Library/Keychains/claude.keychain-db 2>/dev/null
  rm -f /tmp/.claude-token-sync
' 2>/dev/null

rm -f "$TMPFILE"
