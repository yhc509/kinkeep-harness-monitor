import type { ReactNode } from "react";

interface AsyncPaneProps {
  loading: boolean;
  error: string | null;
  hasData?: boolean;
  children: ReactNode;
}

export function AsyncPane({ loading, error, hasData = false, children }: AsyncPaneProps) {
  if (loading && !hasData) {
    return <div className="state-box">Loading data</div>;
  }

  if (error && !hasData) {
    return <div className="state-box error">{error}</div>;
  }

  return (
    <>
      {error && hasData ? <div className="inline-note error-note">{error}</div> : null}
      {children}
    </>
  );
}
