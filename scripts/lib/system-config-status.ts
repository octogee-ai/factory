import fs from "node:fs";
import path from "node:path";

export type SystemConfigState = "clean" | "dirty" | "syncing" | "error" | "unavailable";

export interface SystemConfigObservedStatus {
  state: SystemConfigState;
  acceptedCommit?: string;
  restoredCommit?: string;
  checkpointCommit?: string;
  configHash?: string;
  dirtySince?: string | null;
  lastSyncedAt?: string;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
  schemaVersion?: number;
  openclawVersion?: string;
  doctorResult?: "ok" | "error";
  bootRecovery?: "none" | "recovered" | "unavailable";
  watcherState?: "running" | "stopped";
  freezeState?: "unfrozen" | "freezing" | "frozen";
  rejectedCount?: number;
  recoveryCount?: number;
  updatedAt?: string;
}

export function systemConfigStatusPath(openclawDir: string): string {
  return path.join(openclawDir, "system_config.status.json");
}

function isState(value: unknown): value is SystemConfigState {
  return value === "clean" || value === "dirty" || value === "syncing" ||
    value === "error" || value === "unavailable";
}

const STRING_FIELDS = [
  "acceptedCommit",
  "restoredCommit",
  "checkpointCommit",
  "configHash",
  "lastSyncedAt",
  "openclawVersion",
  "updatedAt",
] as const;

const NULLABLE_STRING_FIELDS = ["dirtySince", "lastErrorCode", "lastErrorAt"] as const;
const NUMBER_FIELDS = ["schemaVersion", "rejectedCount", "recoveryCount"] as const;

function projectSystemConfigStatus(record: Record<string, unknown>): SystemConfigObservedStatus {
  const status: SystemConfigObservedStatus = { state: record.state as SystemConfigState };
  for (const key of STRING_FIELDS) {
    if (typeof record[key] === "string") status[key] = record[key];
  }
  for (const key of NULLABLE_STRING_FIELDS) {
    if (typeof record[key] === "string" || record[key] === null) status[key] = record[key];
  }
  for (const key of NUMBER_FIELDS) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) status[key] = record[key];
  }
  if (record.doctorResult === "ok" || record.doctorResult === "error") {
    status.doctorResult = record.doctorResult;
  }
  if (record.bootRecovery === "none" || record.bootRecovery === "recovered" || record.bootRecovery === "unavailable") {
    status.bootRecovery = record.bootRecovery;
  }
  if (record.watcherState === "running" || record.watcherState === "stopped") {
    status.watcherState = record.watcherState;
  }
  if (record.freezeState === "unfrozen" || record.freezeState === "freezing" || record.freezeState === "frozen") {
    status.freezeState = record.freezeState;
  }
  return status;
}

export function readSystemConfigStatus(openclawDir: string): SystemConfigObservedStatus {
  try {
    const parsed = JSON.parse(fs.readFileSync(systemConfigStatusPath(openclawDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { state: "unavailable" };
    const record = parsed as Record<string, unknown>;
    if (!isState(record.state)) return { state: "unavailable" };
    return projectSystemConfigStatus(record);
  } catch {
    return { state: "unavailable" };
  }
}

export function updateSystemConfigStatus(
  openclawDir: string,
  patch: Partial<SystemConfigObservedStatus> & Pick<SystemConfigObservedStatus, "state">,
  now: () => Date = () => new Date(),
): SystemConfigObservedStatus {
  fs.mkdirSync(openclawDir, { recursive: true });
  const status = {
    ...readSystemConfigStatus(openclawDir),
    ...patch,
    updatedAt: now().toISOString(),
  };
  const target = systemConfigStatusPath(openclawDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  return status;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderSystemConfigMetrics(
  status: SystemConfigObservedStatus,
  now = Date.now(),
): string {
  const states: SystemConfigState[] = ["clean", "dirty", "syncing", "error", "unavailable"];
  const dirtySince = typeof status.dirtySince === "string" ? Date.parse(status.dirtySince) : NaN;
  const dirtyAge = Number.isFinite(dirtySince) ? Math.max(0, (now - dirtySince) / 1000) : 0;
  const lines = [
    "# HELP octogee_system_config_state Current durable config synchronization state.",
    "# TYPE octogee_system_config_state gauge",
    ...states.map((state) => `octogee_system_config_state{state="${state}"} ${status.state === state ? 1 : 0}`),
    "# HELP octogee_system_config_dirty_age_seconds Seconds since durable config first became dirty.",
    "# TYPE octogee_system_config_dirty_age_seconds gauge",
    `octogee_system_config_dirty_age_seconds ${dirtyAge.toFixed(3)}`,
    "# HELP octogee_system_config_rejected_total Rejected config edits observed by this revision.",
    "# TYPE octogee_system_config_rejected_total counter",
    `octogee_system_config_rejected_total ${status.rejectedCount ?? 0}`,
    "# HELP octogee_system_config_recovery_total Recovery commits created by this revision.",
    "# TYPE octogee_system_config_recovery_total counter",
    `octogee_system_config_recovery_total ${status.recoveryCount ?? 0}`,
  ];
  if (status.lastErrorCode) {
    lines.push(
      "# HELP octogee_system_config_last_error Last typed durable config error.",
      "# TYPE octogee_system_config_last_error gauge",
      `octogee_system_config_last_error{code="${escapeLabel(status.lastErrorCode)}"} 1`,
    );
  }
  return `${lines.join("\n")}\n`;
}
