'use strict';

const $ = id => document.getElementById(id);
const make = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const option = (value, text) => Object.assign(make('option', text), { value });
const list = value => Array.isArray(value) ? value : [];
const plain = value => typeof value === 'string' ? value : value?.markdown ?? '';
const sessionKey = (host, session) => JSON.stringify([host, session]);
const drafts = new Map();
const query = new URLSearchParams(location.search);
let selected = query.has('host') && query.has('session') ? { host: query.get('host'), session: query.get('session'), chat: query.get('chat') } : null;
let hosts = [];
let catalogOnline = false;
let snapshot;
let online = false;
let busy = false;
let currentLoad;
let loadingOverview = false;
let pendingSignature;
let transcriptSignature;
let revision = 0;

async function request(path, body) {
  const response = await fetch(path, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(body === undefined ? 24_000 : 40_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
}

function phase(status) {
  if (status & 64) return 'В архиве';
  if ((status & 24) === 24) return 'Ждёт ответа';
  if (status & 8) return 'В работе';
  if (status & 2) return 'Ошибка';
  return 'Свободна';
}

function draftKey() {
  return selected && snapshot?.chatUri ? JSON.stringify([selected.host, snapshot.chatUri]) : undefined;
}

function availability() {
  const blocked = busy || !online || !snapshot?.chatUri;
  $('text').disabled = !snapshot?.chatUri;
  $('send').disabled = blocked || Boolean(snapshot.activeTurn) || Boolean(snapshot.status & 64) || snapshot.lifecycle === 'failed' || !$('text').value.trim();
  $('stop').hidden = !snapshot?.activeTurn;
  $('stop').disabled = blocked;
  for (const button of $('requests').querySelectorAll('button')) button.disabled = blocked;
  $('create-button').disabled = busy || !catalogOnline || !$('create-provider').value;
}

function refreshCreation(resetFolder = false) {
  const host = hosts.find(item => item.id === $('create-host').value);
  const provider = $('create-provider').value;
  $('create-provider').replaceChildren(...list(host?.providers).map(item => option(item.id, item.label)));
  if (list(host?.providers).some(item => item.id === provider)) $('create-provider').value = provider;
  if (resetFolder || !$('directory').value) {
    let folder = '';
    try {
      const uri = new URL(host?.defaultDirectory);
      if (uri.protocol === 'file:') folder = decodeURIComponent(uri.pathname);
    } catch { /* Некоторые хосты не публикуют рабочую папку по умолчанию. */ }
    $('directory').value = folder;
  }
  availability();
}

function renderOverview() {
  const connected = hosts.filter(host => Array.isArray(host.sessions));
  $('connection').textContent = `Хосты подключены: ${connected.length} из ${hosts.length}`;
  $('host-status').replaceChildren(...hosts.map(host => make('li', Array.isArray(host.sessions)
    ? `${host.label} · ${host.sessions.length}${host.moreSessions ? '+' : ''} сессий`
    : `${host.label} · ${host.error || 'Недоступен'}`)));
  const groups = connected.map(host => {
    const group = Object.assign(make('optgroup'), { label: host.label });
    group.append(...host.sessions.map(session => option(sessionKey(host.id, session.uri), `${phase(session.status)} · ${session.title || 'Без названия'}`)));
    return group;
  });
  const key = selected ? sessionKey(selected.host, selected.session) : '';
  const sessions = $('sessions');
  sessions.replaceChildren(option('', 'Выберите сессию'), ...groups);
  if (key && !Array.from(sessions.options).some(item => item.value === key)) sessions.append(option(key, 'Открытая сессия'));
  sessions.value = key;
  const activeHost = $('create-host').value;
  $('create-host').replaceChildren(...connected.map(host => option(host.id, host.label)));
  if (connected.some(host => host.id === activeHost)) $('create-host').value = activeHost;
  refreshCreation();
}

async function updateOverview() {
  if (loadingOverview) return;
  loadingOverview = true;
  try {
    const data = await request('/api/overview');
    if (!Array.isArray(data.hosts)) throw new Error('Не удалось прочитать список хостов');
    hosts = data.hosts;
    catalogOnline = true;
    renderOverview();
  } catch (error) {
    $('connection').textContent = error.message;
    catalogOnline = false;
    online = false;
    availability();
  } finally {
    loadingOverview = false;
  }
}

function setTarget(target) {
  selected = target;
  snapshot = undefined;
  online = false;
  pendingSignature = undefined;
  transcriptSignature = undefined;
  $('text').value = '';
  $('requests').replaceChildren();
  $('transcript').replaceChildren();
  $('session').hidden = true;
  $('empty').hidden = false;
  $('empty').textContent = selected ? 'Загрузка сессии…' : 'Выберите сессию агента.';
  const params = new URLSearchParams();
  if (target) {
    params.set('host', target.host);
    params.set('session', target.session);
    if (target.chat) params.set('chat', target.chat);
  }
  history.replaceState(null, '', params.size ? `/?${params}` : '/');
  notice('');
  renderOverview();
  void updateSession();
}

function renderTranscript() {
  const entries = [...list(snapshot.turns), ...(snapshot.activeTurn ? [snapshot.activeTurn] : [])];
  const signature = JSON.stringify(entries);
  if (signature === transcriptSignature) return;
  const container = $('transcript');
  const follow = transcriptSignature === undefined || container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  transcriptSignature = signature;
  const nodes = entries.filter(Boolean).map(turn => {
    const article = Object.assign(make('article'), { className: 'turn' });
    const agentText = list(turn.responseParts).flatMap(part => {
      if (part?.kind === 'markdown') return [plain(part.content)];
      if (part?.kind === 'error') return [part.error?.message ?? 'Ошибка хода'];
      if (part?.kind === 'toolCall') return [part.toolCall?.displayName ?? part.toolCall?.toolName ?? 'Инструмент'];
      return [];
    }).filter(Boolean).join('\n');
    article.append(Object.assign(make('p', 'Пользователь'), { className: 'speaker' }),
      Object.assign(make('p', turn.message?.text || 'Вложение или служебный ход'), { className: 'message' }));
    if (agentText) article.append(Object.assign(make('p', 'Агент'), { className: 'speaker' }), Object.assign(make('p', agentText), { className: 'message' }));
    return article;
  });
  container.replaceChildren(...(nodes.length === 0 ? [make('p', 'Сообщений пока нет.')] : nodes));
  if (follow) container.scrollTop = container.scrollHeight;
}

function commandButton(text, run) {
  const button = Object.assign(make('button', text), { type: 'button' });
  button.addEventListener('click', run);
  return button;
}

function safeLink(address) {
  try {
    const url = new URL(address);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return Object.assign(make('a', 'Открыть ссылку агента'), { href: url.href, target: '_blank', rel: 'noreferrer noopener' });
    }
  } catch { /* В запросе может не быть ссылки. */ }
}

function fieldFor(question, answer) {
  const { kind } = question;
  const caption = [question.title, question.message].filter((text, index, texts) => text && texts.indexOf(text) === index).join(' · ');
  const label = make('label', caption || question.id);
  const saved = answer?.value?.value ?? question.defaultValue;
  let field;
  let read;
  if (kind === 'boolean' || kind === 'single-select' || kind === 'multi-select') {
    field = make('select');
    field.multiple = kind === 'multi-select';
    if (!field.multiple) field.append(option('', 'Выберите ответ'));
    const choices = kind === 'boolean' ? [{ id: 'true', label: 'Да' }, { id: 'false', label: 'Нет' }] : list(question.options);
    for (const choice of choices) {
      const item = option(choice.id, choice.label ?? choice.id);
      item.selected = Array.isArray(saved) ? saved.includes(choice.id) : saved == null ? Boolean(choice.recommended) : String(saved) === choice.id;
      field.append(item);
    }
    read = () => field.multiple ? Array.from(field.selectedOptions, item => item.value)
      : !field.value ? undefined : kind === 'boolean' ? field.value === 'true' : field.value;
  } else if (kind === 'text' || kind === 'number' || kind === 'integer') {
    field = make('input');
    field.type = kind === 'text' ? 'text' : 'number';
    if (kind === 'text') {
      if (Number.isInteger(question.min)) field.minLength = question.min;
      if (Number.isInteger(question.max)) field.maxLength = question.max;
    } else {
      field.step = kind === 'integer' ? '1' : 'any';
      if (question.min !== undefined) field.min = question.min;
      if (question.max !== undefined) field.max = question.max;
    }
    field.value = saved ?? '';
    read = () => !field.value ? undefined : kind === 'text' ? field.value : field.valueAsNumber;
  } else {
    label.append(make('p', 'Этот тип вопроса можно отклонить или отменить.'));
    return { label, read: () => undefined };
  }
  field.required = Boolean(question.required);
  label.append(field);
  return { label, read };
}

function renderRequests() {
  const active = snapshot.activeTurn;
  const pending = list(active?.responseParts).filter(part =>
    (part?.kind === 'inputRequest' && part.request && part.response === undefined) ||
    (part?.kind === 'toolCall' && ['pending-confirmation', 'pending-result-confirmation'].includes(part.toolCall?.status)));
  const signature = JSON.stringify([active?.id, snapshot.chatUri, pending]);
  if (signature === pendingSignature) return;
  pendingSignature = signature;
  const blocks = pending.map(part => {
    const box = Object.assign(make('article'), { className: 'request' });
    const actions = Object.assign(make('div'), { className: 'actions' });
    const turnId = active.id;
    if (part.kind === 'inputRequest') {
      const input = part.request;
      box.append(make('strong', 'Агент просит ответ'));
      if (input.message) box.append(make('p', input.message));
      const link = safeLink(input.url);
      if (link) box.append(link);
      const form = make('form');
      const fields = list(input.questions).map(question => [question.id, fieldFor(question, input.answers?.[question.id])]);
      form.append(...fields.map(([, field]) => field.label));
      const op = { op: 'input', turnId, requestId: input.id };
      actions.append(Object.assign(make('button', 'Отправить ответ'), { type: 'submit', className: 'primary' }),
        commandButton('Отклонить запрос', () => void command({ ...op, response: 'decline' })),
        commandButton('Отменить запрос', () => void command({ ...op, response: 'cancel' })));
      form.append(actions);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const answers = Object.fromEntries(fields.map(([id, field]) => [id, field.read()]));
        void command({ ...op, response: 'accept', answers });
      });
      box.append(form);
    } else {
      const tool = part.toolCall;
      const result = tool.status === 'pending-result-confirmation';
      box.append(make('strong', `${result ? 'Подтверждение результата' : 'Подтверждение инструмента'} · ${tool.displayName || tool.toolName}`));
      const description = [plain(tool.confirmationTitle), plain(tool.invocationMessage), plain(tool.pastTenseMessage)].filter(Boolean).join('\n');
      if (description) box.append(make('p', description));
      const details = [typeof tool.toolInput === 'string' ? tool.toolInput : '', ...list(tool.content).filter(item => item?.type === 'text').map(item => item.text)].filter(Boolean).join('\n');
      if (details) box.append(make('pre', details));
      const op = { op: 'tool', turnId, toolCallId: tool.toolCallId, status: tool.status };
      const options = result ? [] : list(tool.options);
      if (options.length > 0) {
        for (const choice of options) {
          if (choice.kind !== 'approve' && choice.kind !== 'deny') continue;
          actions.append(commandButton(choice.label, () => void command({ ...op, approved: choice.kind === 'approve', optionId: choice.id })));
        }
      } else {
        actions.append(commandButton(result ? 'Принять результат' : 'Разрешить', () => void command({ ...op, approved: true })),
          commandButton(result ? 'Отклонить результат' : 'Отклонить', () => void command({ ...op, approved: false })));
      }
      box.append(actions);
    }
    return box;
  });
  $('requests').replaceChildren(...blocks);
  $('requests').hidden = blocks.length === 0;
}

async function updateSession() {
  const target = selected;
  if (!target || busy || currentLoad === target) return;
  currentLoad = target;
  const requestedRevision = revision;
  const params = new URLSearchParams({ host: target.host, session: target.session });
  if (target.chat) params.set('chat', target.chat);
  try {
    const data = await request(`/api/session?${params}`);
    if (selected !== target || revision !== requestedRevision) return;
    const oldKey = draftKey();
    snapshot = data;
    online = !data.chatError;
    $('empty').hidden = true;
    $('session').hidden = false;
    $('title').textContent = snapshot.title || 'Новая сессия';
    const error = snapshot.creationError ?? data.chatError;
    $('session-status').textContent = error ?? (data.chatUri ? phase(snapshot.status) : 'Хост пока не открыл чат');
    $('session-status').classList.toggle('error', Boolean(error));
    const chats = list(snapshot.chats);
    $('chat-picker').hidden = chats.length < 2 && !(data.chatError && chats.length);
    $('chats').replaceChildren(...chats.map(chat => option(chat.uri, chat.title || 'Без названия')));
    $('chats').value = data.chatUri ?? '';
    if (oldKey !== draftKey()) $('text').value = drafts.get(draftKey()) ?? '';
    renderTranscript();
    renderRequests();
    availability();
  } catch (error) {
    if (selected !== target || revision !== requestedRevision) return;
    online = false;
    $('empty').textContent = error.message;
    $('session-status').textContent = error.message;
    $('session-status').classList.add('error');
    availability();
  } finally {
    if (currentLoad === target) currentLoad = undefined;
  }
}

async function command(action) {
  if (busy || !online || !selected || !snapshot?.chatUri) return false;
  const target = selected;
  const chat = snapshot.chatUri;
  busy = true;
  revision += 1;
  availability();
  notice('Ждём подтверждения хоста…');
  try {
    await request('/api/command', { ...target, chat, ...action });
    if (selected === target) notice('Хост подтвердил команду.');
    return true;
  } catch (error) {
    if (selected === target) notice(error.message, true);
    return false;
  } finally {
    busy = false;
    if (selected === target) online = false;
    availability();
    void updateSession();
  }
}

$('sessions').addEventListener('change', () => {
  const value = $('sessions').value;
  if (!value) { setTarget(null); return; }
  const [host, session] = JSON.parse(value);
  setTarget({ host, session });
});
$('chats').addEventListener('change', () => setTarget({ ...selected, chat: $('chats').value }));
$('text').addEventListener('input', () => {
  const key = draftKey();
  if (key) drafts.set(key, $('text').value);
  availability();
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const key = draftKey();
  const text = $('text').value;
  if ($('send').disabled || !key) return;
  if (await command({ op: 'send', text }) && drafts.get(key) === text) {
    drafts.delete(key);
    if (draftKey() === key) $('text').value = '';
    availability();
  }
});
$('stop').addEventListener('click', () => void command({ op: 'stop', turnId: snapshot.activeTurn.id }));
$('create-host').addEventListener('change', () => refreshCreation(true));
$('create-provider').addEventListener('change', availability);
$('create').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('create-button').disabled) return;
  const host = $('create-host').value;
  const from = selected;
  busy = true;
  availability();
  notice('Создаём сессию…');
  try {
    const { sessionUri } = await request('/api/session', { host, provider: $('create-provider').value, directory: $('directory').value });
    if (selected === from) {
      $('create-details').open = false;
      setTarget({ host, session: sessionUri });
    }
    void updateOverview();
  } catch (error) {
    if (selected === from) notice(error.message, true);
  } finally {
    busy = false;
    availability();
    void updateSession();
  }
});

function refresh() {
  void updateOverview();
  void updateSession();
}
$('refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) void updateOverview(); }, 12_000);
setInterval(() => { if (!document.hidden) void updateSession(); }, 3500);
if (selected) $('empty').textContent = 'Загрузка сессии…';
refresh();
