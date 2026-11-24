import type { ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Грамматики регистрируются статически: namespace-импорт `lowlight` утащил бы
 * все языки в чанк. Модуль грузится только динамически из `CodeBlock`.
 */
const lowlight = createLowlight({ bash, css, diff, go, javascript, json, markdown, python, rust, sql, typescript, xml, yaml });

/** Hast-дерево с токенами `hljs-*`; `undefined` — подсветка недоступна, рендерим plain-текст. */
export function highlightCode(code: string, language: string): ReactNode | undefined {
  const name = language.trim().toLowerCase();
  if (!code || !name || !lowlight.registered(name)) return undefined;
  try {
    return toJsxRuntime(lowlight.highlight(name, code), { Fragment, jsx, jsxs, ignoreInvalidStyle: true });
  } catch {
    return undefined;
  }
}