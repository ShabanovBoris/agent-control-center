import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Element, ElementContent } from 'hast';
import { copyText } from '../clipboard';

const COPY_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
  </svg>
);

const COPIED_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 13 4 4L19 7" />
  </svg>
);

function classNames(properties: Element['properties']): string[] {
  const value: unknown = properties.className;
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];
}

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return '';
  return node.children.map(textOf).join('');
}

interface CodeDetails {
  code: string;
  language: string;
  codeClassName: string | undefined;
}

/** react-markdown отдаёт `pre > code`; `.map` не нужен — код всегда один. */
function codeDetails(node: Element | undefined): CodeDetails | undefined {
  const code = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  if (!code) return undefined;
  const names = classNames(code.properties);
  const languageClass = names.find(name => name.startsWith('language-'));
  return {
    code: textOf(code),
    language: languageClass?.slice('language-'.length) ?? '',
    codeClassName: names.join(' ') || undefined,
  };
}

/**
 * Оболочка fenced-кода: кнопка копирования и ленивая подсветка.
 * `pre` уже скроллится по горизонтали, поэтому header вынесен наружу.
 */
export function CodeBlock({ node, children, onNotify }: {
  node?: Element;
  children?: ReactNode;
  onNotify?: (text: string) => void;
}) {
  const details = codeDetails(node);
  const code = details?.code;
  const language = details?.language;
  const [highlight, setHighlight] = useState<{ code: string; language: string; content: ReactNode }>();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!code || !language) return;
    let cancelled = false;
    import('../highlight')
      .then(({ highlightCode }) => {
        if (cancelled) return;
        const content = highlightCode(code, language);
        if (content !== undefined) setHighlight({ code, language, content });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [code, language]);

  useEffect(() => () => { window.clearTimeout(copiedTimer.current); }, []);

  if (!details) return <pre>{children}</pre>;

  // Результат от предыдущего текста не показываем: при стриминге это был бы кадр старого кода.
  const highlighted = highlight && highlight.code === code && highlight.language === language ? highlight.content : undefined;

  const copy = async () => {
    const result = await copyText(details.code);
    if (!result.ok) {
      onNotify?.(`Не удалось скопировать код: ${result.message}`);
      return;
    }
    setCopied(true);
    onNotify?.('Код скопирован');
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block">
      <div className="code-block-head">
        {details.language && <span className="code-block-lang">{details.language}</span>}
        <button type="button" className={copied ? 'turn-action code-copy copied' : 'turn-action code-copy'} aria-label="Скопировать код"
          title={copied ? 'Скопировано' : 'Скопировать код'} onClick={copy}>
          {copied ? COPIED_ICON : COPY_ICON}
        </button>
      </div>
      <pre>{highlighted !== undefined
        ? <code className={details.codeClassName}>{highlighted}</code>
        : children}</pre>
    </div>
  );
}