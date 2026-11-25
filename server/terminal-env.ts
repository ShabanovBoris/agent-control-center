// Окружение процесса AHP-хоста: PTY терминалов панели наследует его (кроме `TERM` — его
// внутри PTY выставляет сам хост; замер: при `TERM=dumb` у хоста PTY получал xterm-256color).
//
// AHP 1.1.0 `createTerminal` не принимает `env` (в `CreateTerminalParams` только канал,
// claim, имя, cwd и размер), поэтому задать окружение отдельному PTY из панели нельзя:
// единственная точка влияния — env процесса хоста. Хосты запускают лаунчеры
// `scripts/start-host.sh` (local) и `scripts/start-responses-host.ts` (wbllm/glm),
// и оба нормализуют env до `exec`/`spawn`.
//
// Зачем чистить: CI и agent-раннеры выставляют `NO_COLOR`/`CLICOLOR`/`CI`/`FORCE_COLOR`,
// и TUI на lipgloss/termenv/colorprofile (kent) и Node-TUI (chalk) выбирают Ascii/NoColor —
// выбранный пункт в диалоге перестаёт подсвечиваться. `TERM=dumb` из того же раннера
// отключает цвет у всех, кто смотрит на TERM.
//
// Список синхронизирован с `scripts/start-host.sh`; расхождение ловит
// `server/terminal-env.test.ts`, который проверяет реальный bash-лаунчер.

/** Переменные, которыми CI/agent-раннеры отключают цвет у TUI. */
export const TERMINAL_ENV_UNSET = ['NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'FORCE_COLOR', 'CI'] as const;

/** Возможности xterm.js в панели: 256 цветов и 24-битный SGR. */
export const TERMINAL_ENV_SET = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as const;

/**
 * Копия env для процесса хоста: без цветовраждебных переменных, с терминалом панели.
 * `overrides` — ключи провайдера, `CODEX_HOME` и флаги хоста; `TERM`/`COLORTERM`
 * применяются последними, чтобы их нельзя было переопределить случайно.
 */
export function terminalEnv(
  env: Readonly<NodeJS.ProcessEnv>,
  overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const name of TERMINAL_ENV_UNSET) delete result[name];
  return { ...result, ...overrides, ...TERMINAL_ENV_SET };
}
