import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

const MARKER_FILE = ".octogee-session-policy.json";
const MARKER_SCHEMA_VERSION = 1;

interface SessionPolicyMarker {
  schemaVersion: number;
  fingerprint: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function policyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(policyValue);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, policyValue(source[key])]),
  );
}

function defaultAgentEntry(config: unknown, agentId: string): Record<string, unknown> {
  const agents = record(config)?.agents;
  const entries = record(agents)?.entries;
  const keyedEntries = record(entries);
  if (keyedEntries) {
    const defaultAgent = record(keyedEntries[agentId]);
    if (!defaultAgent) {
      throw new Error(`coach runtime policy: coach ${agentId} missing from agents.entries`);
    }
    return defaultAgent;
  }
  const list = record(agents)?.list;
  if (!Array.isArray(list)) {
    throw new Error(`coach runtime policy: agents.list missing for ${agentId}`);
  }
  const defaultAgent = list.find((entry) => record(entry)?.id === agentId);
  const result = record(defaultAgent);
  if (!result) throw new Error(`coach runtime policy: coach ${agentId} missing from agents.list`);
  return result;
}

export function fingerprintDefaultAgentRuntimePolicy(config: unknown, agentId: string): string {
  const root = record(config);
  if (!root) throw new Error("coach runtime policy: OpenClaw config must be an object");
  const defaultAgent = defaultAgentEntry(root, agentId);
  const payload = {
    globalTools: policyValue(root.tools),
    coachModel: policyValue(defaultAgent.model),
    coachTools: policyValue(defaultAgent.tools),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function markerPath(agentDir: string): string {
  return path.join(agentDir, MARKER_FILE);
}

function readMarker(agentDir: string): SessionPolicyMarker | null {
  const target = markerPath(agentDir);
  if (!fs.existsSync(target)) return null;
  const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  const marker = record(parsed);
  if (
    marker?.schemaVersion !== MARKER_SCHEMA_VERSION ||
    typeof marker.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.fingerprint)
  ) {
    throw new Error(`coach runtime policy: invalid marker at ${target}`);
  }
  return { schemaVersion: MARKER_SCHEMA_VERSION, fingerprint: marker.fingerprint as string };
}

function writeMarker(agentDir: string, fingerprint: string): void {
  const target = markerPath(agentDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ schemaVersion: MARKER_SCHEMA_VERSION, fingerprint })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.renameSync(tmp, target);
}

export async function reconcileDefaultAgentRuntimeSessionPolicy(input: {
  agentDir: string;
  fingerprint: string;
  resetSessions: () => Promise<number>;
}): Promise<{ refreshed: boolean; resetCount: number }> {
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) {
    throw new Error("coach runtime policy: fingerprint must be a SHA-256 hex digest");
  }
  const previous = readMarker(input.agentDir);
  if (previous?.fingerprint === input.fingerprint) return { refreshed: false, resetCount: 0 };
  const resetCount = await input.resetSessions();
  writeMarker(input.agentDir, input.fingerprint);
  return { refreshed: true, resetCount };
}
