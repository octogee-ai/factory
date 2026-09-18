const VM_LABEL_FIELD = (label: string) => `jsonPayload.container.metadata."${label}"`;

const VM_NAMESPACE_FIELD = VM_LABEL_FIELD("ai.octogee.namespace");
const VM_GATEWAY_ID_FIELD = VM_LABEL_FIELD("ai.octogee.gateway-id");
const VM_CONTAINER_FIELD = VM_LABEL_FIELD("ai.octogee.container");

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

const SEVERITIES = new Set([
  "DEFAULT",
  "DEBUG",
  "INFO",
  "NOTICE",
  "WARNING",
  "ERROR",
  "CRITICAL",
  "ALERT",
  "EMERGENCY",
]);

export const FLEET_LOGS_FIELDS = [
  "timestamp",
  "severity",
  "resource.labels.pod_name",
  "resource.labels.container_name",
  "jsonPayload.instance.name",
  "jsonPayload.container.name",
  "textPayload",
  "jsonPayload.msg",
  "jsonPayload.message",
] as const;

const MESSAGE_FIELD_INDEX = FLEET_LOGS_FIELDS.indexOf("textPayload");

export const FLEET_LOGS_FORMAT = `value(${FLEET_LOGS_FIELDS.join(",")})`;

export const FLEET_LOGS_TAIL_ENV = { PYTHONUNBUFFERED: "1" } as const;

const SEVERITY_BY_CODE: Record<string, string> = {
  "0": "DEFAULT",
  "100": "DEBUG",
  "200": "INFO",
  "300": "NOTICE",
  "400": "WARNING",
  "500": "ERROR",
  "600": "CRITICAL",
  "700": "ALERT",
  "800": "EMERGENCY",
};

export function severityName(raw: string): string {
  if (!raw) return "DEFAULT";
  return SEVERITY_BY_CODE[raw] ?? raw.toUpperCase();
}

export interface FleetLogsQuery {
  namespace: string;
  gatewayId?: string;
  container?: string;
  minSeverity?: string;
}

function name(value: string, what: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(`fleet logs ${what} must match ${NAME_PATTERN.source} (got: '${value}')`);
  }
  return value;
}

export function buildFleetLogsFilter(query: FleetLogsQuery): string {
  const namespace = name(query.namespace, "namespace");
  const clauses = [
    `((resource.type="k8s_container" AND resource.labels.namespace_name="${namespace}")` +
      ` OR (resource.type="gce_instance" AND ${VM_NAMESPACE_FIELD}="${namespace}"))`,
  ];

  if (query.gatewayId !== undefined) {
    const gatewayId = name(query.gatewayId, "gateway id");
    clauses.push(
      `(resource.labels.pod_name:"${gatewayId}" OR ${VM_GATEWAY_ID_FIELD}="${gatewayId}")`,
    );
  }

  if (query.container !== undefined) {
    const container = name(query.container, "container");
    clauses.push(
      `(resource.labels.container_name="${container}" OR ${VM_CONTAINER_FIELD}="${container}")`,
    );
  }

  if (query.minSeverity !== undefined) {
    const severity = query.minSeverity.toUpperCase();
    if (!SEVERITIES.has(severity)) {
      throw new Error(`fleet logs severity must be one of ${[...SEVERITIES].join(", ")} (got: '${query.minSeverity}')`);
    }
    clauses.push(`severity>=${severity}`);
  }

  return clauses.join(" AND ");
}

export interface FleetLogsTailInput {
  projectId: string;
  filter: string;
  bufferWindow?: string;
}

export function fleetLogsTailArgs(input: FleetLogsTailInput): string[] {
  return [
    "alpha",
    "logging",
    "tail",
    input.filter,
    `--project=${input.projectId}`,
    `--buffer-window=${input.bufferWindow ?? "2s"}`,
    `--format=${FLEET_LOGS_FORMAT}`,
  ];
}

export interface FleetLogLine {
  timestamp: string;
  severity: string;
  source: string;
  message: string;
}

function trimTabs(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "\t") start++;
  while (end > start && value[end - 1] === "\t") end--;
  return value.slice(start, end);
}

export function parseFleetLogsLine(line: string): FleetLogLine | null {
  const parts = line.split("\t");
  if (parts.length < FLEET_LOGS_FIELDS.length) return null;

  const [timestamp, severity, podName, podContainer, instanceName, vmContainer] = parts;
  const message = trimTabs(parts.slice(MESSAGE_FIELD_INDEX).join("\t"));
  if (!timestamp || !message) return null;

  const host = podName || instanceName;
  const container = podContainer || vmContainer.replace(/^\//, "");
  return {
    timestamp,
    severity: severityName(severity),
    source: [host, container].filter(Boolean).join("/"),
    message,
  };
}

const SEVERITY_COLOR: Record<string, string> = {
  DEBUG: "\x1b[2m",
  INFO: "\x1b[32m",
  NOTICE: "\x1b[32m",
  WARNING: "\x1b[33m",
  ERROR: "\x1b[1;31m",
  CRITICAL: "\x1b[1;31m",
  ALERT: "\x1b[1;31m",
  EMERGENCY: "\x1b[1;31m",
};

const RESET = "\x1b[0m";

export const SOURCE_COLORS = [
  81, 209, 114, 213, 221, 117, 204, 150, 180, 111,
  216, 79, 175, 149, 147, 173, 84, 219, 110, 186,
] as const;

export function sourceColorCode(source: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return SOURCE_COLORS[Math.abs(hash) % SOURCE_COLORS.length];
}

export function renderFleetLogLine(entry: FleetLogLine, options: { color: boolean }): string {
  const clock = entry.timestamp.slice(11, 19) || entry.timestamp;
  if (!options.color) return `${clock} ${entry.severity} ${entry.source} ${entry.message}`;
  const severity = `${SEVERITY_COLOR[entry.severity] ?? ""}${entry.severity}${RESET}`;
  const source = `\x1b[38;5;${sourceColorCode(entry.source)}m${entry.source}${RESET}`;
  const message =
    SEVERITY_COLOR[entry.severity] === SEVERITY_COLOR.ERROR
      ? `\x1b[31m${entry.message}${RESET}`
      : entry.message;
  return `\x1b[2m${clock}${RESET} ${severity} ${source} ${message}`;
}
