// Диагностика: какую модель запросил каждый ход чата и какая модель его выполнила.
// Запуск: npx tsx scripts/turn-models.ts <hostId> <ahp-chat:/... | ahp-session:/...>
// Для сессии берётся её основной чат.
import WebSocket from 'ws';

const [hostId, uri] = process.argv.slice(2);
if (!hostId || !uri) {
  console.error('usage: turn-models.ts <hostId> <chatUri | sessionUri>');
  process.exit(2);
}
const base = process.env.ACC_BACKEND ?? '127.0.0.1:8090';
const socket = new WebSocket(`ws://${base}/ws`, { headers: { origin: `http://${base}` } });
socket.on('open', () => socket.send(JSON.stringify({ t: 'watch', hostId, uri })));
socket.on('message', data => {
  const message = JSON.parse(String(data));
  if (message.t === 'channelError') { console.error(message.error); process.exit(1); }
  if (message.t !== 'snapshot') return;
  if (message.uri.startsWith('ahp-session:')) {
    const chatUri = message.state.defaultChat ?? message.state.chats[0]?.resource;
    if (!chatUri) { console.error('session has no chat'); process.exit(1); }
    socket.send(JSON.stringify({ t: 'watch', hostId, uri: chatUri }));
    return;
  }
  for (const [index, turn] of message.state.turns.entries()) {
    console.log(`${index + 1}. requested=${turn.message.model?.id ?? '(default)'} served=${turn.usage?.model ?? '(no usage)'} state=${turn.state} | ${turn.message.text.slice(0, 40)}`);
  }
  process.exit(0);
});
setTimeout(() => { console.error('timeout'); process.exit(1); }, 6000);
