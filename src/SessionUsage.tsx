import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChatInteractivity, type ChatState, type SessionChatSummary } from '@microsoft/agent-host-protocol';
import { channelKey } from '../shared/reduce';
import { aggregateUsage, chatContextUsage, resolveTimeZone, usageSourceOf } from '../shared/usage';
import { describeError, store, useAppState } from './store';
import { readTokenBudget, saveTokenBudget, usageBudgetLatch } from './usage-budget';
import { formatTokens, formatUsageTotal } from './usage-format';
import { UsageReportDialog } from './UsageReportDialog';
import { UsageTables } from './UsageTables';

const number = new Intl.NumberFormat('ru-RU');
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });

export function SessionUsage({ hostId, sessionUri, sessionTitle, chats, currentChat, provider, connected, backendConnected }: {
  hostId: string;
  sessionUri: string;
  sessionTitle: string;
  chats: readonly SessionChatSummary[];
  currentChat: ChatState | undefined;
  provider: string;
  connected: boolean;
  backendConnected: boolean;
}) {
  const { channels } = useAppState();
  const chatUris = chats.map(chat => chat.resource);
  const resources = chatUris.join('\u0000');
  const requested = useRef(new Map<string, string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState<number>();
  const [budgetDraft, setBudgetDraft] = useState('');
  const [budgetError, setBudgetError] = useState<string>();
  const [reportOpen, setReportOpen] = useState(false);
  const timeZone = useMemo(() => resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC', []);
  const sessionKey = `${hostId}\u0000${sessionUri}`;

  useEffect(() => {
    const releases = resources ? resources.split('\u0000').map(uri => store.watch(hostId, uri)) : [];
    return () => releases.forEach(release => release());
  }, [hostId, resources]);

  useEffect(() => {
    if (!connected || !resources) return;
    for (const uri of resources.split('\u0000')) {
      const view = channels.get(channelKey(hostId, uri));
      const cursor = (view?.state as ChatState | undefined)?.turnsNextCursor;
      if (!cursor || view?.error || errors[uri] || requested.current.get(uri) === cursor) continue;
      // Не запрашиваем одну страницу дважды при повторном запуске эффекта в StrictMode.
      requested.current.set(uri, cursor);
      void store.call({ op: 'fetchTurns', hostId, chatUri: uri, cursor }).catch(error => {
        setErrors(previous => ({ ...previous, [uri]: describeError(error) }));
      });
    }
  }, [hostId, resources, channels, connected, errors]);

  useEffect(() => {
    try {
      setBudget(readTokenBudget(window.localStorage));
    } catch (error) {
      setBudgetError(describeError(error));
    }
  }, []);

  useEffect(() => {
    setBudgetDraft(budget === undefined ? '' : String(budget));
  }, [budget]);

  const views = useMemo(
    () => resources ? resources.split('\u0000').map(uri => channels.get(channelKey(hostId, uri))) : [],
    [resources, channels, hostId],
  );
  const sources = useMemo(
    () => views.map(view => usageSourceOf(view?.state as ChatState | undefined, provider)),
    [views, provider],
  );
  const usage = useMemo(() => aggregateUsage(sources, { timeZone }), [sources, timeZone]);
  const perChat = useMemo(
    () => chats.map((chat, index) => ({
      chat,
      usage: aggregateUsage([sources[index] ?? usageSourceOf(undefined, provider)], { timeZone }),
    })),
    [chats, sources, timeZone, provider],
  );

  const context = chatContextUsage(currentChat);
  const failed = views.flatMap(view => view?.error ? [view.error] : []);
  const pageErrors = Object.entries(errors);
  const loadingHistory = usage.hasMoreTurns && connected && pageErrors.length === 0 && failed.length === 0;
  const overBudget = budget !== undefined && usage.total !== undefined && usage.total >= budget;

  // Уведомление один раз на переход ниже→выше; latch живёт вне React, поэтому StrictMode не спамит.
  useEffect(() => {
    if (budget === undefined) {
      usageBudgetLatch.reset(sessionKey);
      return;
    }
    if (usage.total === undefined) return;
    if (!usageBudgetLatch.observe(sessionKey, usage.total, budget)) return;
    const spent = usage.partial ? `не менее ${formatTokens(usage.total)}` : formatTokens(usage.total);
    store.notify(`Расход сессии «${sessionTitle}» превысил порог: ${spent} из ${formatTokens(budget)} токенов.`);
  }, [sessionKey, budget, usage.total, usage.partial, sessionTitle]);

  const saveBudget = (event: FormEvent) => {
    event.preventDefault();
    const text = budgetDraft.trim();
    try {
      if (!text) {
        saveTokenBudget(window.localStorage, undefined);
        setBudget(undefined);
        setBudgetError(undefined);
        return;
      }
      const value = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
        setBudgetError('Порог должен быть целым числом больше нуля.');
        return;
      }
      saveTokenBudget(window.localStorage, value);
      setBudget(value);
      setBudgetError(undefined);
    } catch (error) {
      store.notify(`Не удалось сохранить порог: ${describeError(error)}`);
    }
  };

  return (
    <footer className="session-usage" aria-label="Расход токенов">
      <details className="usage-disclosure">
        <summary>
          <span className="session-usage-line">
            <span>Токены за сессию: <strong>{formatUsageTotal(usage.total, usage.partial)}</strong></span>
            <span className="context-usage" title={context ? 'По последнему запросу модели в этом чате' : 'Хост не передал данные о заполненности контекста'}>
              Контекст:{' '}
              {context ? (
                <>
                  <strong>{percent.format(context.usedTokens / context.windowTokens)}</strong>
                  <meter aria-hidden="true" min={0} max={context.windowTokens} value={Math.min(context.usedTokens, context.windowTokens)} />
                </>
              ) : 'нет данных'}
            </span>
            {budget !== undefined && (
              <span className={overBudget ? 'usage-over-budget' : undefined}>
                {overBudget && usage.total !== undefined
                  ? `Порог превышен: ${formatUsageTotal(usage.total, usage.partial)} / ${formatTokens(budget)}`
                  : `Порог: ${formatTokens(budget)}`}
              </span>
            )}
            {loadingHistory && <span role="status">Загружается история…</span>}
          </span>
        </summary>
        <div className="session-usage-line usage-breakdown">
          {context && <span>Последний запрос: {number.format(context.usedTokens)} / {number.format(context.windowTokens)} токенов</span>}
          {usage.total !== undefined && (
            <>
              <span>Вход: {number.format(usage.input)}</span>
              <span>Выход: {number.format(usage.output)}</span>
              <span>Из кэша: {number.format(usage.cached)} (включены во вход)</span>
            </>
          )}
          {usage.partial && <span>По доступным данным хоста.</span>}
          {usage.hasMoreTurns && !loadingHistory && <span>История загружена не полностью: суммы — нижняя граница.</span>}
          {provider === 'claude' && <span>Хост Claude не передаёт число токенов записи кэша.</span>}
        </div>
        <UsageTables usage={usage} timeZone={timeZone} />
        {perChat.map(({ chat, usage: chatUsage }) => (
          <details key={chat.resource} className="usage-chat">
            <summary>
              {chat.title || chat.resource}
              {chat.interactivity === ChatInteractivity.Hidden && <span className="muted"> · служебный</span>}
              {' — '}{formatUsageTotal(chatUsage.total, chatUsage.partial)}
              {chatUsage.hasMoreTurns && <span className="muted"> · история неполная</span>}
            </summary>
            <UsageTables usage={chatUsage} timeZone={timeZone} />
          </details>
        ))}
        <details className="usage-disclosure usage-budget">
          <summary>Порог бюджета{budget !== undefined ? `: ${formatTokens(budget)}` : ''}</summary>
          <form onSubmit={saveBudget}>
            <label>
              Порог в токенах{' '}
              <input
                inputMode="numeric"
                value={budgetDraft}
                onChange={event => setBudgetDraft(event.target.value)}
                placeholder="например, 200000"
                aria-invalid={budgetError ? true : undefined}
              />
            </label>
            <button type="submit">Сохранить</button>
            <button
              type="button"
              onClick={() => {
                try {
                  saveTokenBudget(window.localStorage, undefined);
                  setBudget(undefined);
                  setBudgetError(undefined);
                } catch (error) {
                  store.notify(`Не удалось сбросить порог: ${describeError(error)}`);
                }
              }}
            >
              Сбросить
            </button>
            {budgetError && <span className="error-text">{budgetError}</span>}
            <span className="muted">Хранится в этом браузере, без токенов доступа. Уведомление — в панели, один раз на переход порога; push нет.</span>
          </form>
        </details>
        <div className="usage-report-open">
          <button type="button" disabled={!backendConnected} onClick={() => setReportOpen(true)}>Отчёт по всем сессиям</button>
          {!backendConnected && <span className="muted">Нет связи с backend</span>}
        </div>
      </details>
      {failed.map((error, index) => <span key={index} className="error-text" role="status">Не удалось получить данные о токенах: {error}</span>)}
      {pageErrors.map(([uri, error]) => (
        <span key={uri} className="error-text">
          История загружена не полностью: {error}{' '}
          <button disabled={!connected} onClick={() => { requested.current.delete(uri); setErrors(previous => { const next = { ...previous }; delete next[uri]; return next; }); }}>Повторить</button>
        </span>
      ))}
      {reportOpen && <UsageReportDialog timeZone={timeZone} onClose={() => setReportOpen(false)} />}
    </footer>
  );
}
