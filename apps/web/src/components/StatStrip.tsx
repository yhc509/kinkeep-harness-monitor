import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface StatStripItem {
  label: string;
  value: string;
  meta?: string;
  accent?: "cool" | "warm" | "neutral";
  icon?: LucideIcon;
  extra?: ReactNode;
}

interface StatStripProps {
  items: StatStripItem[];
}

export function StatStrip({ items }: StatStripProps) {
  return (
    <section className="stat-strip" aria-label="summary stats">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <article key={item.label} className={`stat-strip-item ${item.accent ?? "neutral"}`}>
            <div className="stat-strip-main">
              {Icon ? (
                <span className="stat-strip-icon" aria-hidden="true">
                  <Icon size={16} strokeWidth={2.2} />
                </span>
              ) : null}
              <div className="stat-strip-copy">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                {item.meta ? <p>{item.meta}</p> : null}
              </div>
            </div>
            {item.extra ? <div className="stat-strip-extra">{item.extra}</div> : null}
          </article>
        );
      })}
    </section>
  );
}
