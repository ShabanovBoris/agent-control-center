import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ToolResultContentType,
  type ToolResultContent,
  type ToolResultEmbeddedResourceContent,
  type ToolResultResourceContent,
  type ToolResultTextContent,
} from '@microsoft/agent-host-protocol';
import { ToolResultsDisplay } from './ui/ToolResultsDisplay.js';

function render(content: ToolResultContent[]): string {
  return renderToStaticMarkup(createElement(ToolResultsDisplay, { content }));
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

test('FileEdit, Terminal и Subagent не создают блоков результата', () => {
  const content: ToolResultContent[] = [
    { type: ToolResultContentType.Text, text: 'visible' },
    { type: ToolResultContentType.FileEdit },
    { type: ToolResultContentType.Terminal, resource: 'ahp-terminal:/one', title: 'terminal' },
    { type: ToolResultContentType.Subagent, resource: 'ahp-chat:/worker', title: 'worker' },
  ];

  assert.equal(
    render(content),
    '<div class="tool-results"><div class="tool-result-text"><pre>visible</pre></div></div>',
  );
});

test('неизвестный вариант расширенного SDK пропускается', () => {
  // The SDK marks this union non-exhaustive; simulate a future runtime variant.
  const futureContent = { type: 'futureContent' } as unknown as ToolResultContent;

  assert.equal(render([futureContent]), '<div class="tool-results"></div>');
});
