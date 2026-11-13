function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function timestampMillis(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (finiteNumber(value)) return value;
  if (value instanceof Date) return value.getTime();
  const candidate = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  if (candidate && typeof candidate.toMillis === "function") {
    const millis = (candidate.toMillis as () => unknown)();
    return finiteNumber(millis) ? millis : undefined;
  }
  if (candidate && finiteNumber(candidate.seconds)) {
    const nanos = typeof candidate.nanoseconds === "number" ? candidate.nanoseconds : 0;
    return candidate.seconds * 1_000 + nanos / 1_000_000;
  }
  return undefined;
}
