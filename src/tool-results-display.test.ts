import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ToolResultContentType,
  type ToolResultContent,
  type ToolResultEmbeddedResourceContent,
  type ToolResultResourceContent,
  type ToolResultSubagentContent,
  type ToolResultTerminalContent,
  type ToolResultTextContent,
} from '@microsoft/agent-host-protocol';
import type { SubagentNavigation } from './tool-results.js';
import { ToolResultsDisplay } from './ui/ToolResultsDisplay.js';

function render(content: ToolResultContent[], subagentNavigation?: SubagentNavigation): string {
  return renderToStaticMarkup(createElement(ToolResultsDisplay, { content, subagentNavigation }));
}

test('пустой результат не создаёт карточку', () => {
  assert.equal(render([]), '');
});

test('Text сохраняет пробелы в pre и экранирует HTML', () => {
  const text: ToolResultTextContent = {
    type: ToolResultContentType.Text,
    text: '  <script>& "x"  \n',
  };

  assert.equal(
    render([text]),
    '<div class="tool-results"><div class="tool-result-text"><pre>  &lt;script&gt;&amp; &quot;x&quot;  \n</pre></div></div>',
  );
});

test('EmbeddedResource показывает встроенное превью только для поддерживаемых изображений', () => {
  const images: ToolResultEmbeddedResourceContent[] = [
    { type: ToolResultContentType.EmbeddedResource, contentType: 'image/png', data: 'cG5n' },
    { type: ToolResultContentType.EmbeddedResource, contentType: 'image/jpeg', data: 'anBlZw==' },
    { type: ToolResultContentType.EmbeddedResource, contentType: 'image/gif', data: 'Z2lm' },
    { type: ToolResultContentType.EmbeddedResource, contentType: 'image/webp', data: 'd2VicA==' },
  ];
  const markup = render(images);

  for (const { contentType, data } of images) {
    assert.ok(markup.includes(`src="data:${contentType};base64,${data}"`));
  }
  assert.equal((markup.match(/<img\b/g) ?? []).length, images.length);
});

test('остальные EmbeddedResource показывают только MIME-метку без скачивания', () => {
  const resources: ToolResultEmbeddedResourceContent[] = [
    { type: ToolResultContentType.EmbeddedResource, contentType: 'application/pdf', data: 'cGRmLWRhdGE=' },
    { type: ToolResultContentType.EmbeddedResource, contentType: 'application/octet-stream', data: 'YmluYXJ5LWRhdGE=' },
  ];
  const markup = render(resources);

  assert.ok(markup.includes('application/pdf'));
  assert.ok(markup.includes('application/octet-stream'));
  assert.doesNotMatch(markup, /<img\b|<a\b|data:/);
  assert.doesNotMatch(markup, /cGRmLWRhdGE=|YmluYXJ5LWRhdGE=/);
});

test('Resource показывает только URI обычным текстом', () => {
  const resource: ToolResultResourceContent = {
    type: ToolResultContentType.Resource,
    uri: 'ahp-content:/resource?name=a&kind=b',
  };

  assert.equal(
    render([resource]),
    '<div class="tool-results"><div class="tool-result-label">ahp-content:/resource?name=a&amp;kind=b</div></div>',
  );
});

test('FileEdit не создаёт блока результата', () => {
  const content: ToolResultContent[] = [
    { type: ToolResultContentType.Text, text: 'visible' },
    { type: ToolResultContentType.FileEdit },
  ];

  assert.equal(
    render(content),
    '<div class="tool-results"><div class="tool-result-text"><pre>visible</pre></div></div>',
  );
});

function terminal(overrides: Partial<Omit<ToolResultTerminalContent, 'type'>> = {}): ToolResultContent {
  return {
    type: ToolResultContentType.Terminal,
    resource: 'ahp-terminal:/cmd',
    title: 'printf hello',
    ...overrides,
  };
}

function subagent(overrides: Partial<Omit<ToolResultSubagentContent, 'type'>> = {}): ToolResultContent {
  return {
    type: ToolResultContentType.Subagent,
    resource: 'ahp-chat:/worker',
    title: 'Исследование',
    ...overrides,
  };
}

test('Terminal с успешным результатом показывает заголовок, вывод и код выхода', () => {
  const markup = render([terminal({ result: { exitCode: 0, preview: 'hello\n' } })]);

  assert.match(markup, /<section class="terminal-output" title="ahp-terminal:\/cmd"/);
  assert.ok(markup.includes('printf hello'));
  assert.match(markup, /<pre class="terminal-content">hello\n<\/pre>/);
  assert.ok(markup.includes('Код выхода: 0'));
  assert.ok(markup.includes('exit-success'));
  assert.doesNotMatch(markup, /terminal-error|exit-error/);
});

test('Terminal с ненулевым кодом выхода помечает вывод ошибкой', () => {
  const markup = render([terminal({ result: { exitCode: 1, preview: 'boom\n' } })]);

  assert.ok(markup.includes('Код выхода: 1'));
  assert.ok(markup.includes('exit-error'));
  assert.match(markup, /<pre class="terminal-content terminal-error">boom\n<\/pre>/);
});

test('Terminal без result сообщает, что итог не передан, и не выдумывает код выхода', () => {
  const markup = render([terminal()]);

  assert.ok(markup.includes('Хост не передал итог команды'));
  assert.ok(markup.includes('Код выхода не сообщён'));
  assert.ok(!markup.includes('Код выхода:'));
  assert.doesNotMatch(markup, /<pre|terminal-error|exit-error/);
});

test('Terminal с result без preview отличается от пустого вывода', () => {
  const noPreview = render([terminal({ result: { exitCode: 0 } })]);
  const empty = render([terminal({ result: { exitCode: 0, preview: '' } })]);

  assert.ok(noPreview.includes('Хост не передал текст вывода команды'));
  assert.ok(noPreview.includes('Код выхода: 0'));
  assert.ok(empty.includes('Команда завершилась без вывода'));
  assert.ok(!empty.includes('Хост не передал текст вывода команды'));
});

test('длинный вывод терминала сворачивается, короткий показывается целиком', () => {
  const longPreview = Array.from({ length: 21 }, (_, index) => `line ${index}`).join('\n');
  const long = render([terminal({ result: { exitCode: 0, preview: longPreview } })]);
  const short = render([terminal({ result: { exitCode: 0, preview: 'one line' } })]);

  assert.match(long, /<details class="terminal-long">/);
  assert.ok(long.includes('Показать вывод'));
  assert.ok(long.includes('21 строк'));
  assert.ok(long.includes('line 20'));
  assert.doesNotMatch(short, /<details/);
  assert.match(short, /<pre class="terminal-content">one line<\/pre>/);
});

test('Terminal показывает пометки обрезки и PTY', () => {
  const markup = render([terminal({ isPty: true, result: { exitCode: 0, preview: 'out', truncated: true } })]);

  assert.ok(markup.includes('Вывод обрезан'));
  assert.ok(markup.includes('>PTY</span>'));
  assert.equal((markup.match(/class="badge"/g) ?? []).length, 2);
});

test('Terminal экранирует текст вывода и заголовка', () => {
  const markup = render([terminal({ title: '<b>cmd</b>', result: { exitCode: 0, preview: '<script>x</script>' } })]);

  assert.ok(markup.includes('&lt;b&gt;cmd&lt;/b&gt;'));
  assert.ok(markup.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.doesNotMatch(markup, /<script>/);
});

test('Subagent с доступным чатом показывает карточку и кнопку перехода', () => {
  const markup = render(
    [subagent({ agentName: 'explore', description: 'найти вызовы' })],
    { availableChats: new Set(['ahp-chat:/worker']), onOpenChat: () => {} },
  );

  assert.ok(markup.includes('class="subagent-card"'));
  assert.ok(markup.includes('Исследование'));
  assert.ok(markup.includes('explore'));
  assert.ok(markup.includes('найти вызовы'));
  assert.match(markup, /<button type="button" class="subagent-open" title="ahp-chat:\/worker">Открыть чат подагента<\/button>/);
});

test('Subagent без доступного чата показывает недоступность без кнопки', () => {
  const unlisted = render(
    [subagent()],
    { availableChats: new Set(['ahp-chat:/other']), onOpenChat: () => {} },
  );
  const noNavigation = render([subagent()]);

  for (const markup of [unlisted, noNavigation]) {
    assert.ok(markup.includes('Чат подагента недоступен в этой сессии'));
    assert.doesNotMatch(markup, /<button/);
    assert.ok(markup.includes('Исследование'));
  }
});

test('смешанный content сохраняет порядок частей', () => {
  const markup = render([
    { type: ToolResultContentType.Text, text: 'before' },
    terminal({ result: { exitCode: 0, preview: 'out' } }),
    subagent({ resource: 'ahp-chat:/visible' }),
    { type: ToolResultContentType.FileEdit },
    { type: ToolResultContentType.Text, text: 'after' },
  ], { availableChats: new Set(['ahp-chat:/visible']), onOpenChat: () => {} });

  const order = ['before', 'terminal-head', 'subagent-card', 'after'].map(fragment => markup.indexOf(fragment));
  assert.ok(order.every(index => index >= 0), `фрагменты не найдены: ${order.join(',')}`);
  assert.deepEqual([...order].sort((left, right) => left - right), order);
  assert.equal((markup.match(/subagent-card/g) ?? []).length, 1);
});

test('неизвестный вариант расширенного SDK пропускается', () => {
  // The SDK marks this union non-exhaustive; simulate a future runtime variant.
  const futureContent = { type: 'futureContent' } as unknown as ToolResultContent;

  assert.equal(render([futureContent]), '<div class="tool-results"></div>');
});
