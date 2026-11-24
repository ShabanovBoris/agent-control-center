import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { highlightCode } from './highlight.js';

const SUPPORTED = [
  'ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'json', 'bash', 'sh', 'zsh',
  'python', 'py', 'go', 'golang', 'rust', 'rs', 'sql', 'yaml', 'yml', 'diff', 'patch',
  'html', 'xml', 'css', 'markdown', 'md',
];

function renderHighlight(code: string, language: string): string {
  const result = highlightCode(code, language);
  assert.ok(result !== undefined, `нет результата для ${language}`);
  return renderToStaticMarkup(result as ReactNode);
}

test('поддерживаемые языки и алиасы дают React-дерево', () => {
  for (const language of SUPPORTED) {
    assert.ok(isValidElement(highlightCode('const a = 1;', language)), `${language} не подсвечен`);
  }
});

test('неизвестный язык и пустой ввод — без подсветки', () => {
  for (const language of ['mermaid', 'text', '']) {
    assert.equal(highlightCode('x', language), undefined, `${language} не должен подсвечиваться`);
  }
  assert.equal(highlightCode('', 'ts'), undefined);
});

test('язык нормализуется по регистру и пробелам', () => {
  assert.ok(isValidElement(highlightCode('let a = 1;', '  TS ')));
});

test('подсветка экранирует HTML и не исполняет скрипты', () => {
  const markup = renderHighlight('const a = 1 < 2;', 'ts');

  assert.ok(markup.includes('hljs-keyword'));
  assert.ok(markup.includes('&lt;'));
  assert.doesNotMatch(markup, /<script\b/);

  const script = renderHighlight('<script>alert(1)</script>', 'html');
  assert.doesNotMatch(script, /<script\b/);
});

test('повторные вызовы не зависят от предыдущего результата', () => {
  const first = renderHighlight('const a = 1;', 'ts');
  const second = renderHighlight('const b = 2;', 'js');

  assert.ok(first?.includes('hljs-keyword'));
  assert.ok(second?.includes('hljs-keyword'));
  assert.ok(second?.includes('b'));
});