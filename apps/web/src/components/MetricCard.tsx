import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  accent?: "warm" | "cool" | "neutral";
  extra?: ReactNode;
  icon?: LucideIcon;
}

export function MetricCard({ label, value, hint, accent = "neutral", extra, icon: Icon }: MetricCardProps) {
  return (
    <article className={`metric-card ${accent}`}>
      <header>
        <div className="metric-label-stack">
          <span>{label}</span>
          {hint ? <p>{hint}</p> : null}
        </div>
        <div className="metric-trailing">
          {Icon ? (
            <span className="metric-icon" aria-hidden="true">
              <Icon size={16} strokeWidth={2.2} />
            </span>
          ) : null}
          {extra}
        </div>
      </header>
      <strong>{value}</strong>
    </article>
  );
}
