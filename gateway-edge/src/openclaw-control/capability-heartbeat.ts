import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "@octogee/shared/types/fleet-controller";

export {
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
};

export interface OpenClawDashboardCapabilityHeartbeat {
  publish: () => void;
  stop: () => void;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for the OpenClaw Dashboard bridge heartbeat`);
  return value;
}

function readRuntimeIdentity(openclawDir: string): {
  openclawVersion: string;
  openclawForkSha: string;
} {
  const raw = JSON.parse(
    fs.readFileSync(path.join(openclawDir, "system_config.status.json"), "utf8"),
  ) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("OpenClaw runtime identity status is invalid");
  }
  const status = raw as Record<string, unknown>;
  const openclawVersion = typeof status.openclawVersion === "string"
    ? status.openclawVersion.trim()
    : "";
  const openclawForkSha = typeof status.openclawForkSha === "string"
    ? status.openclawForkSha.trim()
    : "";
  if (!openclawVersion || !openclawForkSha) {
    throw new Error("OpenClaw runtime identity status is unavailable");
  }
  return { openclawVersion, openclawForkSha };
}

export function startOpenClawDashboardCapabilityHeartbeat(args: {
  env: NodeJS.ProcessEnv;
  logError: (error: unknown) => void;
  instanceId?: string;
  now?: () => number;
  intervalMs?: number;
}): OpenClawDashboardCapabilityHeartbeat | null {
  if (args.env.OPENCLAW_DASHBOARD_BRIDGE_ENABLED !== "true") return null;
  const openclawDir = requiredEnv(args.env, "OPENCLAW_DIR");
  const revisionId = requiredEnv(args.env, "GATEWAY_REVISION_ID");
  const instanceId = args.instanceId ?? randomUUID();
  const now = args.now ?? Date.now;
  const target = path.join(openclawDir, OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE);
  const temporary = `${target}.${instanceId}.tmp`;
  const publish = (): void => {
    const { openclawVersion, openclawForkSha } = readRuntimeIdentity(openclawDir);
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify({
      protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
      version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
      revisionId,
      openclawVersion,
      openclawForkSha,
      instanceId,
      observedAt: new Date(now()).toISOString(),
    })}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
  };
  fs.rmSync(target, { force: true });
  try {
    publish();
  } catch (error) {
    args.logError(error);
  }
  const timer = setInterval(() => {
    try {
      publish();
    } catch (error) {
      args.logError(error);
    }
  }, args.intervalMs ?? 5_000);
  timer.unref?.();
  return {
    publish,
    stop: () => {
      clearInterval(timer);
      try {
        const current = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
        if (current !== null && typeof current === "object" && !Array.isArray(current) &&
          (current as Record<string, unknown>).instanceId === instanceId) {
          fs.rmSync(target, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") args.logError(error);
      }
      fs.rmSync(temporary, { force: true });
    },
  };
}
