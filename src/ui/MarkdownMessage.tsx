import { memo, useMemo, type ReactElement, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const REMARK_PLUGINS = [remarkGfm];

function protocolOf(url: string): string | undefined {
  const match = SCHEME.exec(url);
  return match?.[1] ? `${match[1].toLowerCase()}:` : undefined;
}

/** Ссылки безопасных схем и относительные пути; `//host` не считаем относительным. */
function safeLink(url: string | undefined): string | undefined {
  const value = url?.trim();
  if (!value || value.startsWith('//')) return undefined;
  const protocol = protocolOf(value);
  return protocol === undefined || SAFE_LINK_PROTOCOLS.has(protocol) ? value : undefined;
}

function inlineImage(url: string | undefined): string | undefined {
  const value = url?.trim();
  return value && /^data:image\//i.test(value) ? value : undefined;
}

/**
 * react-markdown не передаёт тип атрибута, поэтому здесь только грубый фильтр;
 * решения, что реально попадёт в DOM, принимают компоненты `a` и `img` ниже.
 */
function urlTransform(url: string): string {
  const value = url.trim();
  if (!value || value.startsWith('//')) return '';
  if (inlineImage(value)) return value;
  const protocol = protocolOf(value);
  if (protocol === undefined || SAFE_LINK_PROTOCOLS.has(protocol)) return value;
  return '';
}

function heading(level: number) {
  // Заголовки документа заняты шапкой приложения, поэтому не создаём h1–h6.
  return function MarkdownHeading({ children }: { children?: ReactNode }): ReactElement {
    return <div role="heading" aria-level={level}>{children}</div>;
  };
}

const link: Components['a'] = ({ href, children }) => {
  const safe = safeLink(href);
  return safe
    ? <a href={safe} target="_blank" rel="noreferrer noopener">{children}</a>
    : <span>{children}</span>;
};

const image: Components['img'] = ({ src, alt }) => {
  const inline = inlineImage(src);
  if (inline) return <img src={inline} alt={alt ?? ''} />;
  const label = alt || 'изображение';
  const safe = safeLink(src);
  // Внешние картинки не загружаем: показываем ссылку с alt-текстом.
  return safe
    ? <a href={safe} target="_blank" rel="noreferrer noopener">{label}</a>
    : <span>{label}</span>;
};

const table: Components['table'] = ({ children }) => (
  <div className="markdown-table"><table>{children}</table></div>
);

const COMPONENTS: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  a: link,
  img: image,
  table,
};

/** Markdown-реплика агента; memo по `content`, чтобы неизменные части не парсились на каждом чанке. */
export const MarkdownMessage = memo(function MarkdownMessage({ content, onNotify }: {
  content: string;
  onNotify?: (text: string) => void;
}) {
  const components = useMemo<Components>(() => ({
    ...COMPONENTS,
    pre: ({ node, children }) => <CodeBlock node={node} onNotify={onNotify}>{children}</CodeBlock>,
  }), [onNotify]);

  return (
    <div className="markdown-message">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={urlTransform}>
        {content}
      </Markdown>
    </div>
  );
});
