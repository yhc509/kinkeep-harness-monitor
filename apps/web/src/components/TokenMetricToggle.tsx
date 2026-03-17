import type { TokenMetricMode } from "../hooks/useTokenMetricMode";

interface TokenMetricToggleProps {
  mode: TokenMetricMode;
  onChange: (mode: TokenMetricMode) => void;
}

export function TokenMetricToggle({ mode, onChange }: TokenMetricToggleProps) {
  return (
    <div className="segmented">
      <button
        type="button"
        className={mode === "uncached" ? "segment active" : "segment"}
        onClick={() => onChange("uncached")}
      >
        캐시 제외
      </button>
      <button
        type="button"
        className={mode === "total" ? "segment active" : "segment"}
        onClick={() => onChange("total")}
      >
        캐시 포함
      </button>
    </div>
  );
}
