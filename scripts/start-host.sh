#!/usr/bin/env bash
# Запускает локальный Agent Host VS Code с включённым Codex.
# Токен подключения генерируется один раз и лежит в .local/host-token (вне git).
set -euo pipefail
cd "$(dirname "$0")/.."

CODE="${VSCODE_CLI:-/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code}"
PORT="${AHP_PORT:-8089}"
TOKEN_FILE=".local/host-token"

mkdir -p .local
if [ "${1:-}" = --log ]; then
  LOG_FILE=".local/host.log"
  if [ -L "$LOG_FILE" ] || { [ -e "$LOG_FILE" ] && [ ! -f "$LOG_FILE" ]; }; then
    echo "start-host: ожидался обычный файл $LOG_FILE" >&2
    exit 1
  fi
  (umask 077; : >> "$LOG_FILE")
  chmod 600 "$LOG_FILE"
  exec >> "$LOG_FILE" 2>&1
fi
if [ ! -s "$TOKEN_FILE" ]; then
  (umask 077; openssl rand -hex 32 > "$TOKEN_FILE")
fi

# Codex в Agent Host экспериментальный и по умолчанию выключен.
export VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED=true

export VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED=false

HOST_DATA_DIR="${AHP_SERVER_DATA_DIR:-$PWD/.local/host-data}"
if [ -z "${VSCODE_AGENT_HOST_CODEX_SDK_ROOT:-}" ] && [ "${AHP_USE_BUNDLED_SDK:-0}" != 1 ]; then
  CODEX_SDK_ROOT="$(node scripts/agent-sdks.mjs "$HOST_DATA_DIR")"
  if [ -n "$CODEX_SDK_ROOT" ]; then
    export VSCODE_AGENT_HOST_CODEX_SDK_ROOT="$CODEX_SDK_ROOT"
  fi
fi
args=(agent host --host 127.0.0.1 --port "$PORT" --connection-token-file "$TOKEN_FILE" --foreground --new-instance)
args+=(--server-data-dir "$HOST_DATA_DIR")

exec "$CODE" "${args[@]}"
