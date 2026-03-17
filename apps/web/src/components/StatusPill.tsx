import { statusLabel } from "../utils/format";

export function StatusPill({ status }: { status: "success" | "warning" | "failure" }) {
  return <span className={`status-pill ${status}`}>{statusLabel(status)}</span>;
}
