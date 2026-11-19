import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '@microsoft/agent-host-protocol';
import { channelKey } from '../shared/reduce';
import { describeError, store, useAppState } from './store';
import { chatContextUsage, sessionTokenUsage } from './usage';

const number = new Intl.NumberFormat('ru-RU');
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });

export function SessionUsage({ hostId, chatUris, currentChat, provider, connected }: {
  hostId: string;
  chatUris: string[];
  currentChat: ChatState | undefined;
  provider: string;
  connected: boolean;
}) {
  const { channels } = useAppState();
  const resources = chatUris.join('\u0000');
  const requested = useRef(new Map<string, string>());
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  const views = chatUris.map(uri => channels.get(channelKey(hostId, uri)));
  const usage = sessionTokenUsage(views.map(view => view?.state as ChatState | undefined), provider);
  const context = chatContextUsage(currentChat);
  const failed = views.flatMap(view => view?.error ? [view.error] : []);
  const pageErrors = Object.entries(errors);
  const loadingHistory = usage.hasMoreTurns && connected && pageErrors.length === 0 && failed.length === 0;

  return (
    <footer className="session-usage" aria-label="Расход токенов">
      <details className="usage-disclosure">
        <summary>
          <span className="session-usage-line">
            <span>Токены за сессию: <strong>{usage.total === undefined ? 'нет данных' : `${usage.partial ? '≥ ' : ''}${number.format(usage.total)}`}</strong></span>
            <span className="context-usage" title={context ? 'По последнему запросу модели в этом чате' : 'Хост не передал данные о заполненности контекста'}>
              Контекст:{' '}
              {context ? (
                <>
                  <strong>{percent.format(context.usedTokens / context.windowTokens)}</strong>
                  <meter aria-hidden="true" min={0} max={context.windowTokens} value={Math.min(context.usedTokens, context.windowTokens)} />
                </>
              ) : 'нет данных'}
            </span>
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
          {provider === 'claude' && <span>Хост Claude не передаёт число токенов записи кэша.</span>}
        </div>
      </details>
      {failed.map((error, index) => <span key={index} className="error-text" role="status">Не удалось получить данные о токенах: {error}</span>)}
      {pageErrors.map(([uri, error]) => (
        <span key={uri} className="error-text">
          История загружена не полностью: {error}{' '}
          <button disabled={!connected} onClick={() => { requested.current.delete(uri); setErrors(previous => { const next = { ...previous }; delete next[uri]; return next; }); }}>Повторить</button>
        </span>
      ))}
    </footer>
  );
}
