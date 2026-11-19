import { type ReactNode } from 'react';

interface SubagentCardProps {
  name: string;
  type?: string;
  label?: string;
  image?: string;
  children?: ReactNode;
}

export function SubagentCard({ name, type, label, image, children }: SubagentCardProps): ReactNode {
  return (
    <div className="subagent-card">
      <div className="subagent-header">
        {image && <img src={image} alt={name} className="subagent-avatar" />}
        <div className="subagent-info">
          <div className="subagent-name">{name}</div>
          {type && <div className="subagent-type">{type}</div>}
          {label && <div className="subagent-label">{label}</div>}
        </div>
      </div>
      {children && <div className="subagent-content">{children}</div>}
    </div>
  );
}
