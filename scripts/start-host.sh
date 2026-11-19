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

PROVIDER_ENV_FILE="${AHP_PROVIDER_ENV_FILE:-.local/model-provider.env}"
if [ ! -f "$PROVIDER_ENV_FILE" ]; then
  echo "start-host: укажите API_KEY и BASE_URL в $PROVIDER_ENV_FILE (образец: model-provider.env.example)" >&2
  exit 1
fi
set -a
source "$PROVIDER_ENV_FILE"
set +a
: "${API_KEY:?В файле провайдера нет API_KEY}"
: "${BASE_URL:?В файле провайдера нет BASE_URL}"

# Подписка не должна переопределить выбранный API — в том числе при запуске из Claude Code.
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FD ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_API_KEY="$API_KEY"
export ANTHROPIC_BASE_URL="${BASE_URL%/}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL%/v1}"
export AHP_CLAUDE_API_KEY="$API_KEY"
export AHP_CLAUDE_BASE_URL="$ANTHROPIC_BASE_URL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${CLAUDE_SONNET_MODEL:-claude-sonnet-5-5}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${CLAUDE_OPUS_MODEL:-claude-opus-5-5}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${CLAUDE_HAIKU_MODEL:-claude-haiku-5-5}"
export ANTHROPIC_DEFAULT_FABLE_MODEL="${CLAUDE_FABLE_MODEL:-claude-fable-5-2}"
# Codex использует прежнюю конфигурацию и вход ChatGPT, без параметров API-провайдера.

HOST_DATA_DIR="${AHP_SERVER_DATA_DIR:-$PWD/.local/host-data}"
if [ -z "${VSCODE_AGENT_HOST_CODEX_SDK_ROOT:-}" ] && [ "${AHP_USE_BUNDLED_SDK:-0}" != 1 ]; then
  CODEX_SDK_ROOT="$(node scripts/agent-sdks.mjs "$HOST_DATA_DIR")"
  if [ -n "$CODEX_SDK_ROOT" ]; then
    export VSCODE_AGENT_HOST_CODEX_SDK_ROOT="$CODEX_SDK_ROOT"
  fi
fi
CLAUDE_SDK_ROOT="$(node scripts/claude-provider.mjs "$HOST_DATA_DIR")"
if [ -n "$CLAUDE_SDK_ROOT" ]; then
  export VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT="$CLAUDE_SDK_ROOT"
fi

args=(agent host --host 127.0.0.1 --port "$PORT" --connection-token-file "$TOKEN_FILE" --foreground --new-instance)
args+=(--server-data-dir "$HOST_DATA_DIR")

exec "$CODE" "${args[@]}"
