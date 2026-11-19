import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContentEncoding,
  ResponsePartKind,
  ToolCallConfirmationReason,
  ToolCallStatus,
  ToolResultContentType,
  type FileEditSide,
  type ResponsePart,
  type ToolResultFileEditContent,
} from '@microsoft/agent-host-protocol';
import { collectFileEdits, decodeFileText, fileDiffHunks, filesFromChangeset, resolveTurnChangeset, sumDiffStats } from './file-edits.js';

const side = (file: string, version: string): FileEditSide => ({
  uri: `file:///workspace/${file}`,
  content: { uri: `session-db:/${version}` },
});

function write(id: string, edit?: ToolResultFileEditContent, success = true): ResponsePart {
  return {
    kind: ResponsePartKind.ToolCall,
    toolCall: {
      toolCallId: id,
      toolName: 'Write',
      displayName: 'Write file',
      status: ToolCallStatus.Completed,
      confirmed: ToolCallConfirmationReason.UserAction,
      invocationMessage: 'Write file',
      pastTenseMessage: 'Wrote file',
      success,
      ...(edit && { content: [edit] }),
    },
  };
}

test('история группирует снимки из успешных вызовов по файлам', () => {
  const created: ToolResultFileEditContent = { type: ToolResultContentType.FileEdit, after: side('a.md', '1'), diff: { added: 5, removed: 0 } };
  const edited: ToolResultFileEditContent = { type: ToolResultContentType.FileEdit, before: side('a.md', '1'), after: side('a.md', '2'), diff: { added: 1, removed: 2 } };
  const removed: ToolResultFileEditContent = { type: ToolResultContentType.FileEdit, before: side('b.md', '3'), diff: { removed: 5 } };
  const { files } = collectFileEdits([write('a1', created), write('a2', edited), write('b', removed), write('failed', edited, false)]);
  assert.deepEqual([...files], [['file:///workspace/a.md', [created, edited]], ['file:///workspace/b.md', [removed]]]);
  assert.deepEqual(sumDiffStats([created, edited]), { added: 6, removed: 2 });
  assert.deepEqual(sumDiffStats([created, removed]), { added: undefined, removed: 5 });
});

test('успешный вызов без снимка позволяет загрузить набор изменений хода', () => {
  assert.deepEqual(collectFileEdits([write('legacy')]), { files: new Map(), hasFileEditCall: true });
  assert.deepEqual(collectFileEdits([write('failed', undefined, false)]), { files: new Map(), hasFileEditCall: false });
  assert.deepEqual(sumDiffStats([]), { added: 0, removed: 0 });
});

test('резервное чтение использует ровно опубликованный URI изменений конкретного хода', () => {
  assert.equal(resolveTurnChangeset('ahp-chat:/chat/changeset/turn/{turnId}', 'a/b ?'), 'ahp-chat:/chat/changeset/turn/a%2Fb%20%3F');
  assert.equal(resolveTurnChangeset('ahp-changeset:/chat/{turnId}', 'older'), 'ahp-changeset:/chat/older');
  assert.equal(resolveTurnChangeset('ahp-chat:/chat/changeset/session', 'older'), undefined);
  assert.equal(resolveTurnChangeset('ahp-changeset:/{turnId}/{other}', 'older'), undefined);
  assert.equal(resolveTurnChangeset('ahp-chat:/{turnId}', 'older'), undefined);
});

test('файлы восстановленного хода сохраняют исходные ссылки на обе версии', () => {
  const edit = { before: side('a.md', 'old'), after: side('a.md', 'new'), diff: { added: 3, removed: 1 } };
  const removed = { before: side('b.md', 'old'), diff: { added: 0, removed: 1 } };
  assert.deepEqual([...filesFromChangeset([{ id: 'a', edit }, { id: 'b', edit: removed }])], [
    ['file:///workspace/a.md', [edit]],
    ['file:///workspace/b.md', [removed]],
  ]);
});

test('исторический дифф показывает добавление, удаление и номера начала среза', () => {
  assert.deepEqual(fileDiffHunks('первая\nстарая\n', 'первая\nновая\n'), [{
    oldStart: 1,
    newStart: 1,
    oldLines: 2,
    newLines: 2,
    lines: [' первая', '-старая', '+новая'],
  }]);
  assert.equal(fileDiffHunks('', 'новая\n')[0]?.lines[0], '+новая');
  assert.deepEqual(fileDiffHunks('та же строка\n', 'та же строка\n'), []);
});

test('текст версии читается с учётом кодировки ответа хоста', () => {
  const data = 'Сохранённый файл\n';
  assert.equal(decodeFileText({ encoding: ContentEncoding.Utf8, data }), data);
  assert.equal(decodeFileText({ encoding: ContentEncoding.Base64, data: Buffer.from(data).toString('base64') }), data);
  assert.throws(() => decodeFileText({ encoding: ContentEncoding.Base64, data: 'AP8=' }), /UTF-8/);
});
