import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  icon?: ReactNode;
}

export function Panel({ title, subtitle, actions, children, icon }: PanelProps) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div className="panel-title">
          {icon ? <span className="panel-icon" aria-hidden="true">{icon}</span> : null}
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
