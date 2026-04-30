import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BreakEventCard, type CacheBreakEventWithDate } from "./BreakEventCard";

const PAGE_SIZE = 5;

interface CacheBreakSidePanelProps {
  events: CacheBreakEventWithDate[];
  selectedDate: string | null;
  onClearFilter: () => void;
}

export function CacheBreakSidePanel({ events, selectedDate, onClearFilter }: CacheBreakSidePanelProps) {
  const [currentPage, setCurrentPage] = useState<number>(1);

  const visibleEvents = useMemo(() => {
    return [...events]
      .filter((event) => selectedDate == null || event.date === selectedDate)
      .sort(compareCacheBreakEvents);
  }, [events, selectedDate]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedDate]);

  const totalPages = Math.max(1, Math.ceil(visibleEvents.length / PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages);
  const pageItems = useMemo(() => getPaginationItems(totalPages, activePage), [activePage, totalPages]);
  const paginatedEvents = useMemo(() => {
    const startIndex = (activePage - 1) * PAGE_SIZE;

    return visibleEvents.slice(startIndex, startIndex + PAGE_SIZE);
  }, [activePage, visibleEvents]);

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
        <>
          <div className="cache-break-list">
            {paginatedEvents.map((event) => (
              <BreakEventCard key={`${event.rolloutPath}:${event.turnIndex}:${event.ts}`} event={event} />
            ))}
          </div>

          <nav className="cache-break-pagination" aria-label="Break events pagination">
            <button
              type="button"
              aria-label="Previous page"
              disabled={activePage <= 1}
              onClick={() => setCurrentPage(Math.max(1, activePage - 1))}
            >
              <ChevronLeft size={14} strokeWidth={2.2} />
            </button>

            {pageItems.map((item, index) =>
              item === "ellipsis" ? (
                <span key={`ellipsis-${index}`} className="page-ellipsis">
                  ...
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={item === activePage ? "active" : undefined}
                  aria-current={item === activePage ? "page" : undefined}
                  onClick={() => setCurrentPage(item)}
                >
                  {item}
                </button>
              ),
            )}

            <button
              type="button"
              aria-label="Next page"
              disabled={activePage >= totalPages}
              onClick={() => setCurrentPage(Math.min(totalPages, activePage + 1))}
            >
              <ChevronRight size={14} strokeWidth={2.2} />
            </button>
          </nav>
        </>
      ) : (
        <div className="cache-break-empty">깨짐 이벤트 없음</div>
      )}
    </aside>
  );
}

type PageItem = number | "ellipsis";

function getPaginationItems(totalPages: number, currentPage: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 3) {
    return [1, 2, 3, 4, "ellipsis", totalPages];
  }

  if (currentPage >= totalPages - 2) {
    return [1, "ellipsis", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}

function compareCacheBreakEvents(left: CacheBreakEventWithDate, right: CacheBreakEventWithDate): number {
  if (left.date !== right.date) {
    return right.date.localeCompare(left.date);
  }

  return right.ts - left.ts;
}
