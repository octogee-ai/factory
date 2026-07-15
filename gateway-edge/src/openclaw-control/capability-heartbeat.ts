import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "@octogee/shared/types/fleet-controller";
import {
  CANONICAL_OPENCLAW_FORK_SHA,
  CANONICAL_OPENCLAW_VERSION,
} from "@octogee/shared/types/openclaw-release";

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
  const openclawVersion = requiredEnv(args.env, "OPENCLAW_VERSION");
  const openclawForkSha = requiredEnv(args.env, "OPENCLAW_FORK_SHA");
  if (openclawVersion !== CANONICAL_OPENCLAW_VERSION || openclawForkSha !== CANONICAL_OPENCLAW_FORK_SHA) {
    throw new Error("OpenClaw Dashboard bridge runtime identity does not match the canonical pin");
  }
  const instanceId = args.instanceId ?? randomUUID();
  const now = args.now ?? Date.now;
  const target = path.join(openclawDir, OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE);
  const temporary = `${target}.${instanceId}.tmp`;
  const publish = (): void => {
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
  publish();
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
