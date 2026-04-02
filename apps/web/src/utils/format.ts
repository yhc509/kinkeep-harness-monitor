export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) {
    return "$0.00";
  }

  const absoluteValue = Math.abs(value);
  if (absoluteValue > 0 && absoluteValue < 0.0001) {
    return value < 0 ? "-<$0.0001" : "<$0.0001";
  }

  const fractionDigits = absoluteValue >= 0.01 ? 2 : 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(value);
}

export function formatShortNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

export function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric"
  }).format(date);
}

export function formatHour(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }

  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

export function statusLabel(status: "success" | "warning" | "failure"): string {
  if (status === "success") {
    return "Healthy";
  }

  if (status === "warning") {
    return "Warning";
  }

  return "Failed";
}
