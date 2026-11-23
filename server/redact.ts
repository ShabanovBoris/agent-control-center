export const REDACTED = '<redacted>';

// Имена query-параметров, в которых CLI и хосты передают токены доступа.
const SECRET_QUERY = /([?&](?:tkn|token|access_token|refresh_token|api_key|apikey|key|secret|password|sig|signature))=([^&#\s"']*)/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
// Переменные окружения и CLI-флаги в верхнем регистре: API_KEY=..., AHP_SOME_TOKEN='...'.
const SECRET_ENV = /\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)|API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*("[^"]*"|'[^']*'|[^\s&;,'"]+)/g;
// Токены проекта из `openssl rand -hex 32` / `randomBytes(32).toString('hex')`.
const HEX_TOKEN = /\b[0-9a-f]{64}\b/gi;

/**
 * Убирает из текста токены и ключи перед показом в браузере. Best-effort защита в глубину:
 * журнал может содержать локальные пути и текст сессий, поэтому доступ к нему остаётся
 * в доверенной модели управления агентами. Функция идемпотентна.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_QUERY, `$1=${REDACTED}`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(SECRET_ENV, `$1=${REDACTED}`)
    .replace(HEX_TOKEN, REDACTED);
}
