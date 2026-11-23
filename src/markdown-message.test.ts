import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from './ui/MarkdownMessage.js';

function render(content: string): string {
  return renderToStaticMarkup(createElement(MarkdownMessage, { content }));
}

test('заголовок не становится документным h1–h6', () => {
  const markup = render('## Заголовок');

  assert.ok(markup.includes('<div role="heading" aria-level="2">Заголовок</div>'));
  assert.doesNotMatch(markup, /<h[1-6]\b/);
});

test('списки, вложенные списки и task-list рендерятся структурой', () => {
  const nested = render('- один\n- два\n  - вложенный');
  assert.equal((nested.match(/<li>/g) ?? []).length, 3);
  assert.ok(nested.includes('<ul>\n<li>один</li>'));
  assert.ok(nested.includes('<li>два\n<ul>\n<li>вложенный</li>\n</ul>\n</li>'));

  const tasks = render('- [ ] задача\n- [x] готово');
  assert.ok(tasks.includes('class="task-list-item"'));
  assert.ok(tasks.includes('<input type="checkbox" disabled=""/>'));
  assert.ok(tasks.includes('<input type="checkbox" disabled="" checked=""/>'));
});

test('fenced-код сохраняет язык и экранирует HTML внутри', () => {
  assert.equal(
    render('```ts\nconst a = 1 < 2;\n```'),
    '<div class="markdown-message"><pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre></div>',
  );
});

test('inline-код и код с отступом в начале реплики', () => {
  assert.ok(render('текст `code`').includes('<code>code</code>'));
  assert.equal(
    render('    const x = 1;'),
    '<div class="markdown-message"><pre><code>const x = 1;\n</code></pre></div>',
  );
});

test('GFM-таблица рендерится таблицей', () => {
  const markup = render('| a | b |\n| - | - |\n| 1 | 2 |');

  assert.ok(markup.includes('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'));
});

test('raw HTML показывается текстом и не исполняется', () => {
  const markup = render('<script>alert(1)</script>');

  assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.doesNotMatch(markup, /<script\b/);
});

test('ссылки: безопасные схемы открываются в новой вкладке, javascript: не становится ссылкой', () => {
  const safe = render('[ok](https://e)');
  assert.ok(safe.includes('<a href="https://e" target="_blank" rel="noreferrer noopener">ok</a>'));

  const unsafe = render('[x](javascript:alert(1))');
  assert.doesNotMatch(unsafe, /href="javascript:/);
  assert.ok(unsafe.includes('<span>x</span>'));

  const dataLink = render('[x](data:image/png;base64,AAAA)');
  assert.ok(!dataLink.includes('<a '));
  assert.ok(dataLink.includes('<span>x</span>'));

  const fragment = render('[раздел](#section)');
  assert.ok(fragment.includes('<a href="#section" target="_blank" rel="noreferrer noopener">раздел</a>'));

  const vbscript = render('[x](vbscript:msgbox(1))');
  assert.doesNotMatch(vbscript, /href="vbscript:/);
  assert.ok(vbscript.includes('<span>x</span>'));
});

test('внешняя картинка не загружается, inline data:image рендерится', () => {
  const external = render('![a](https://e/x.png)');
  assert.doesNotMatch(external, /<img\b/);
  assert.ok(external.includes('<a href="https://e/x.png" target="_blank" rel="noreferrer noopener">a</a>'));

  const inline = render('![b](data:image/png;base64,AAAA)');
  assert.ok(inline.includes('<img src="data:image/png;base64,AAAA" alt="b"/>'));

  const unsafe = render('![c](javascript:alert(1))');
  assert.ok(!unsafe.includes('<img') && !unsafe.includes('<a '));
  assert.ok(unsafe.includes('<span>c</span>'));

  assert.doesNotMatch(external + inline, /<link\b|rel="preload"/);
});

test('одиночный перевод строки внутри абзаца — мягкий перенос GFM, а не <br>', () => {
  const markup = render('Первая строка\nВторая строка');

  assert.ok(markup.includes('<p>Первая строка\nВторая строка</p>'));
  assert.doesNotMatch(markup, /<br\s*\/?>/);

  const hardBreak = render('Первая строка  \nВторая строка');
  assert.ok(hardBreak.includes('<br/>'));
});

test('частично пришедший markdown не падает и остаётся читаемым', () => {
  const fence = render('Текст\n\n```js\nconst a = ');
  assert.ok(fence.includes('<pre><code class="language-js">const a = \n</code></pre>'));

  const emphasis = render('**Полуж');
  assert.ok(emphasis.includes('**Полуж'));
  assert.doesNotMatch(emphasis, /<strong>/);

  const table = render('| a | b |\n| - | - |\n| 1 |');
  assert.ok(table.includes('<table>'));
  assert.ok(table.includes('<td>1</td><td></td>'));
});

test('пустой контент не создаёт блоков', () => {
  assert.equal(render(''), '<div class="markdown-message"></div>');
});
