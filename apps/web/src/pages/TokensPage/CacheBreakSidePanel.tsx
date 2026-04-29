import { X } from "lucide-react";
import { useMemo } from "react";
import { BreakEventCard, type CacheBreakEventWithDate } from "./BreakEventCard";

interface CacheBreakSidePanelProps {
  events: CacheBreakEventWithDate[];
  selectedDate: string | null;
  onClearFilter: () => void;
}

export function CacheBreakSidePanel({ events, selectedDate, onClearFilter }: CacheBreakSidePanelProps) {
  const visibleEvents = useMemo(() => {
    return [...events]
      .filter((event) => selectedDate == null || event.date === selectedDate)
      .sort(compareCacheBreakEvents);
  }, [events, selectedDate]);

  return (
    <aside className="cache-break-side-panel">
      <header className="cache-break-side-header">
        <div>
          <span>Break events</span>
          <strong>{selectedDate ?? "all"}</strong>
        </div>
        <button className="ghost-button cache-break-clear" disabled={selectedDate == null} onClick={onClearFilter}>
          <X size={14} strokeWidth={2.2} />
          clear
        </button>
      </header>

      {visibleEvents.length > 0 ? (
        <div className="cache-break-list">
          {visibleEvents.map((event) => (
            <BreakEventCard key={`${event.rolloutPath}:${event.turnIndex}:${event.ts}`} event={event} />
          ))}
        </div>
      ) : (
        <div className="cache-break-empty">깨짐 이벤트 없음</div>
      )}
    </aside>
  );
}

function compareCacheBreakEvents(left: CacheBreakEventWithDate, right: CacheBreakEventWithDate): number {
  if (left.date !== right.date) {
    return right.date.localeCompare(left.date);
  }

  return right.ts - left.ts;
}
