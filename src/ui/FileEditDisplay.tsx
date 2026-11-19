import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChangesetStatus, type ChangesetState, type FileEdit, type FileEditDiffStats, type FileEditSide, type ResourceReadResult } from '@microsoft/agent-host-protocol';
import { decodeFileText, fileDiffHunks, filesFromChangeset, MAX_DIFF_FILE_BYTES, sumDiffStats } from '../file-edits';
import { pathOf } from '../format';
import { describeError, store, useChannel } from '../store';

interface FileEditDisplayProps {
  files: ReadonlyMap<string, readonly [FileEdit, ...FileEdit[]]>;
  hostId: string;
  workingDirectory: string | undefined;
  changesetUri?: string;
}

export function FileEditDisplay({ files, hostId, workingDirectory, changesetUri }: FileEditDisplayProps) {
  const folder = pathOf(workingDirectory).replace(/\/$/, '');
  const card = useRef<HTMLElement>(null);
  const [requested, setRequested] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const element = card.current;
    if (!changesetUri || requested || !element) return;
    // Хост вычисляет историю по запросу. Загружаем данные по мере приближения карточек к экрану.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setRequested(true);
    }, { root: element.closest('.transcript'), rootMargin: '400px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [changesetUri, requested]);

  const observing = requested ? changesetUri : undefined;
  const { state: changeset, error: channelError } = useChannel<ChangesetState>(hostId, observing);
  const entries = changeset?.files;
  const visibleFiles = useMemo(() => entries ? filesFromChangeset(entries) : files, [entries, files]);
  const status = changeset?.status;
  const ready = !changesetUri || status === ChangesetStatus.Ready || status === ChangesetStatus.Recomputing;
  const totals = useMemo(() => ready ? sumDiffStats([...visibleFiles.values()].flat()) : undefined, [ready, visibleFiles]);
  const error = channelError ?? (changeset?.status === ChangesetStatus.Error
    ? changeset.error?.message ?? 'Хост не смог вычислить изменения.' : undefined);
  const loading = observing && !ready && !error;
  return (
    <section ref={card} className="file-edits" aria-label="Изменённые файлы">
      <header className="file-edits-head">
        <strong>Изменённые файлы {ready && visibleFiles.size > 0 && <span className="muted">{visibleFiles.size}</span>}</strong>
        {loading && <span className="muted" role="status">Загрузка…</span>}
        {totals && <DiffCounts stats={totals} />}
        {changesetUri && (
          <button type="button" className="file-edits-toggle" aria-expanded={opened} onClick={() => {
            setRequested(true);
            setOpened(value => !value);
          }}>{opened ? 'Скрыть' : 'Показать'}</button>
        )}
      </header>
      {error && <p className="file-edit-note error-text" role="status">{error}</p>}
      <div hidden={!!changesetUri && !opened}>
        {ready && visibleFiles.size === 0 && <p className="file-edit-note muted">В наборе изменений этого хода нет файлов.</p>}
        {[...visibleFiles].map(([uri, edits]) => {
          const path = pathOf(uri);
          const name = folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
          const summary = (
            <>
              <span className="file-edit-path" title={path}>{name}</span>
              <DiffCounts stats={sumDiffStats(edits)} />
            </>
          );

          if (edits.length === 1) {
            return <FileDiff key={diffKey(edits[0])} hostId={hostId} edit={edits[0]} summary={summary} />;
          }
          return (
            <details className="file-edit" key={uri}>
              <summary className="file-edit-label">{summary}</summary>
              <div className="file-edit-versions">
                {edits.map((edit, index) => (
                  <FileDiff key={`${diffKey(edit)}:${index}`} hostId={hostId} edit={edit} summary={(
                    <>
                      <span className="file-edit-path">Правка {index + 1}</span>
                      {edit.diff && <DiffCounts stats={edit.diff} />}
                    </>
                  )} />
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function diffKey(edit: FileEdit): string {
  return JSON.stringify([edit.before?.uri, edit.after?.uri, edit.before?.content, edit.after?.content]);
}

function DiffCounts({ stats }: { stats: FileEditDiffStats }) {
  if (stats.added === undefined && stats.removed === undefined) return null;
  return (
    <span className="file-edit-counts" title="Добавленные и удалённые строки по показанным правкам">
      {stats.added !== undefined && <span className="diff-added">+{stats.added}</span>}
      {stats.removed !== undefined && <span className="diff-removed">−{stats.removed}</span>}
    </span>
  );
}

async function readFileVersion(hostId: string, side: FileEditSide | undefined): Promise<string> {
  if (!side) return '';
  const content = side.content;
  if (!content?.uri || content.uri === side.uri) throw new Error('Хост не предоставил сохранённую версию файла.');
  if (content.sizeHint !== undefined && content.sizeHint > MAX_DIFF_FILE_BYTES) {
    throw new Error('Файл слишком велик для предпросмотра.');
  }
  const result = await store.call<ResourceReadResult>({ op: 'readResource', hostId, uri: content.uri });
  return decodeFileText(result);
}

type DiffView =
  | { kind: 'loading' }
  | { kind: 'ready'; hunks: ReturnType<typeof fileDiffHunks> }
  | { kind: 'error'; message: string };

function FileDiff({ hostId, edit, summary }: { hostId: string; edit: FileEdit; summary: ReactNode }) {
  const [view, setView] = useState<DiffView>();
  const pending = useRef(false);

  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    setView({ kind: 'loading' });
    try {
      const [before, after] = await Promise.all([readFileVersion(hostId, edit.before), readFileVersion(hostId, edit.after)]);
      setView({ kind: 'ready', hunks: fileDiffHunks(before, after) });
    } catch (error) {
      setView({ kind: 'error', message: describeError(error) });
    } finally {
      pending.current = false;
    }
  };

  return (
    <details className="file-edit" onToggle={event => {
      if (event.currentTarget.open && !view) void load();
    }}>
      <summary className="file-edit-label">{summary}</summary>
      {edit.before && edit.after && edit.before.uri !== edit.after.uri && (
        <p className="file-edit-note muted">{pathOf(edit.before.uri)} → {pathOf(edit.after.uri)}</p>
      )}
      {view?.kind === 'loading' && <p className="file-edit-note muted" role="status">Загрузка сохранённых версий…</p>}
      {view?.kind === 'error' && (
        <div className="row file-edit-note">
          <span className="error-text" role="status">{view.message}</span>
          <button type="button" onClick={() => void load()}>Повторить</button>
        </div>
      )}
      {view?.kind === 'ready' && (view.hunks.length > 0
        ? <DiffTable hunks={view.hunks} />
        : <p className="file-edit-note muted">В сохранённых версиях нет различий.</p>)}
    </details>
  );
}

function DiffTable({ hunks }: { hunks: ReturnType<typeof fileDiffHunks> }) {
  return (
    <div className="file-diff-scroll" tabIndex={0} role="region" aria-label="Построчные изменения">
      <table className="file-diff">
        {hunks.map(hunk => {
          let before = hunk.oldStart;
          let after = hunk.newStart;
          return (
            <tbody key={`${before}:${after}`}>
              <tr className="file-diff-range">
                <td colSpan={4}>@@ −{before - Number(hunk.oldLines === 0)},{hunk.oldLines} +{after - Number(hunk.newLines === 0)},{hunk.newLines} @@</td>
              </tr>
              {hunk.lines.map((line, index) => {
                const prefix = line[0];
                if (prefix === '\\') {
                  return <tr key={index} className="file-diff-range"><td colSpan={4}>Нет перевода строки в конце файла</td></tr>;
                }
                const kind = prefix === '+' ? 'added' : prefix === '-' ? 'removed' : 'context';
                return (
                  <tr key={index} className={`file-diff-${kind}`}>
                    <td className="file-diff-number">{prefix !== '+' && before++}</td>
                    <td className="file-diff-number">{prefix !== '-' && after++}</td>
                    <td className="file-diff-prefix">{prefix}</td>
                    <td className="file-diff-code"><code>{line.slice(1)}</code></td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
