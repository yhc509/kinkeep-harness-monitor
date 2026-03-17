const JSON_SNIPPET_LIMIT = 420;

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function toLocalDateTime(value: Date | number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + "T" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

export function fromEpochSeconds(value: number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return toLocalDateTime(value * 1000);
}

export function startOfLocalHour(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    0,
    0,
    0
  );
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function formatHourBucket(date: Date): string {
  const hourDate = startOfLocalHour(date);
  return toLocalDateTime(hourDate) ?? "";
}

export function formatDayKey(date: Date | string): string {
  const input = typeof date === "string" ? new Date(date) : date;
  return [
    input.getFullYear(),
    pad(input.getMonth() + 1),
    pad(input.getDate())
  ].join("-");
}

export function stringifySnippet(value: unknown): string {
  if (typeof value === "string") {
    return value.length > JSON_SNIPPET_LIMIT ? `${value.slice(0, JSON_SNIPPET_LIMIT)}...` : value;
  }

  const text = JSON.stringify(value, null, 2);

  if (!text) {
    return "";
  }

  return text.length > JSON_SNIPPET_LIMIT ? `${text.slice(0, JSON_SNIPPET_LIMIT)}...` : text;
}

export function humanizeEventName(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
