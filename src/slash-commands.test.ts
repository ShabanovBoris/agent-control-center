import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageAttachmentKind, type CompletionItem } from '@microsoft/agent-host-protocol';
import { applySlashItem, requestSlashItems, sendSlashDraft } from './slash-commands';

const rename: CompletionItem = {
  insertText: '/rename ', rangeStart: 0, rangeEnd: 4,
  attachment: { type: MessageAttachmentKind.Simple, label: '/rename', _meta: { command: 'rename', opaque: { value: 1 } } },
};

test('устаревшие ответы не публикуются ни после правки, ни после закрытия чата', async () => {
  const published: string[] = [];
  const publish = (result: string) => published.push(result);
  requestSlashItems(Promise.resolve('old draft'), publish)();
  requestSlashItems(Promise.resolve('previous chat'), publish)();
  requestSlashItems(Promise.resolve('current'), publish);
  await Promise.resolve();
  assert.deepEqual(published, ['current']);
});

test('выбор подставляет команду, а отказ хоста оставляет аргументы и вложение в черновике', async () => {
  const inserted = applySlashItem('/ren', 4, rename);
  assert.equal(inserted, '/rename ');
  let draft = `${inserted}Новое имя`;
  let calls = 0;
  const send = async (text: string, item: CompletionItem | undefined) => {
    assert.equal(text, '/rename Новое имя');
    assert.equal(item?.attachment, rename.attachment);
    return ++calls > 1;
  };
  const clear = () => { draft = ''; };
  await sendSlashDraft(draft, rename, async () => assert.fail('Выбранное вложение уже есть'), send, clear);
  assert.equal(draft, '/rename Новое имя');
  await sendSlashDraft(draft, undefined, async command => {
    assert.equal(command, '/rename');
    return [rename];
  }, send, clear);
  assert.equal(draft, '');
});

test('goal и неизвестная команда не запускают ход, обычный текст и отправка без текста работают без подсказок', async () => {
  const noSend = async () => assert.fail('Не должен стартовать ход');
  const noClear = () => assert.fail('Черновик не должен очищаться');
  await assert.rejects(sendSlashDraft('/goal test', undefined, async () => assert.fail('Нет запроса'), noSend, noClear), /не поддерживает/);
  await assert.rejects(sendSlashDraft('/unknown test', undefined, async () => [], noSend, noClear), /недоступна/);
  for (const text of ['Обычное сообщение', '', '/tmp/path']) {
    let cleared = false;
    await sendSlashDraft(text, undefined, async () => assert.fail('Нет запроса'), async (sent, item) => {
      assert.equal(sent, text);
      assert.equal(item, undefined);
      return true;
    }, () => { cleared = true; });
    assert.equal(cleared, true);
  }
});
