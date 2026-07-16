import type { BuilderGatewayConfigStatus } from "@octogee/shared/types/builder-shell";

const STATES = new Set(["clean", "dirty", "syncing", "error", "unavailable"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

export function projectOpenClawConfigStatus(
  heartbeat: Record<string, unknown> | null,
): BuilderGatewayConfigStatus | undefined {
  const source = record(heartbeat?.configStatus);
  if (!source || typeof source.state !== "string" || !STATES.has(source.state)) return undefined;
  const acceptedCommit = boundedString(source.acceptedCommit, 128);
  const lastSyncedAt = boundedString(source.lastSyncedAt, 64);
  const lastErrorCode = boundedString(source.lastErrorCode, 80);
  return {
    state: source.state as BuilderGatewayConfigStatus["state"],
    ...(acceptedCommit ? { acceptedCommit } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
  };
}
