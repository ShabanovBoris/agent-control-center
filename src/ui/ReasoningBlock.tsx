import { type ReactNode } from 'react';

interface ReasoningBlockProps {
  content: string;
}

export function ReasoningBlock({ content }: ReasoningBlockProps): ReactNode {
  const text = content.trim();
  if (!text) return null;

  return <div className="reasoning">{text}</div>;
}
