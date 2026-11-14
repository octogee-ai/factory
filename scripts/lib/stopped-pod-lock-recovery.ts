import { podBelongsToGateway } from "@octogee/core/gateway-live-release";
import type { OpenClawCommand, OpenClawCommandResult } from "./openclaw-cli.js";
import { clusterIsolatedGateway } from "./openclaw-state-store.js";

const HOLDER_HOST = /(?:^|: )holder (?:\d+|unknown) at ([^\s,/]+)(?:\/pid-ns \d+)?, last renewed /u;

interface GatewayLockInspection {
  present: boolean;
  holders: string[];
  confirmation: string;
}

export function gatewayLockHolderHost(holder: string): string | null {
  return HOLDER_HOST.exec(holder)?.[1] ?? null;
}

function jsonDocument(stdout: string, what: string): Record<string, unknown> {
  const text = stdout.trim();
  const start = text.startsWith("{") ? 0 : text.indexOf("\n{") + 1;
  if (start === 0 && !text.startsWith("{")) throw new Error(`${what} printed no JSON document`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch (error) {
    throw new Error(`${what} printed unreadable JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${what} printed no JSON object`);
  return parsed as Record<string, unknown>;
}

function succeeded(result: OpenClawCommandResult, what: string): string {
  if (result.code === 0) return result.stdout;
  const diagnostic = (result.stderr?.trim() || result.stdout.trim()).slice(0, 2000);
  const detail = diagnostic ? ": " + diagnostic : "";
  throw new Error(`${what} failed (exit ${result.code})${detail}`);
}

function readInspection(stdout: string): GatewayLockInspection {
  const document = jsonDocument(stdout, "Gateway lock inspection");
  const { present, holders, confirmation } = document;
  if (typeof present !== "boolean" || !Array.isArray(holders) || !holders.every((holder) => typeof holder === "string") ||
      (present && (typeof confirmation !== "string" || !/^[0-9a-f]{64}$/u.test(confirmation)))) {
    throw new Error("Gateway lock inspection has an unexpected shape");
  }
  return { present, holders, confirmation: String(confirmation) };
}

export async function recoverStoppedPodGatewayLocks(input: {
  env: NodeJS.ProcessEnv;
  hostname: string;
  run: OpenClawCommand;
  stoppedPods: (hosts: string[]) => Promise<string[]>;
  log: (message: string) => void;
}): Promise<"absent" | "held" | "recovered"> {
  if (!clusterIsolatedGateway(input.env)) return "absent";
  const gatewayId = input.env.GATEWAY_ID?.trim() ?? "";
  const options = { env: input.env };
  const inspection = readInspection(succeeded(await input.run(["gateway", "recover-lock", "--json"], options), "Gateway lock inspection"));
  if (!inspection.present) return "absent";
  const hosts = [...new Set(inspection.holders.map((holder) => {
    const host = gatewayLockHolderHost(holder);
    if (!host) throw new Error(`Gateway lock holder record names no pod: ${holder}`);
    return host;
  }))];
  if (hosts.includes(input.hostname)) {
    input.log(`[state-store] this pod ${input.hostname} holds a Gateway lock record; OpenClaw decides whether it stopped`);
    return "held";
  }
  for (const host of hosts) {
    if (!podBelongsToGateway(gatewayId, host)) {
      throw new Error(`Gateway lock holder ${host} is not a pod of gateway ${gatewayId}; refusing foreign state ownership`);
    }
  }
  const stopped = new Set(await input.stoppedPods(hosts));
  const running = hosts.filter((host) => !stopped.has(host));
  if (running.length) {
    input.log(`[state-store] Gateway lock holder pod ${running.join(", ")} still exists; leaving its records`);
    return "held";
  }
  const outcome = jsonDocument(succeeded(
    await input.run(["gateway", "recover-lock", "--confirm", inspection.confirmation, "--json"], options),
    "Gateway lock recovery",
  ), "Gateway lock recovery");
  if (outcome.recovered !== true) throw new Error("Gateway lock recovery did not report a recovery");
  input.log(`[state-store] recovered ${String(outcome.removed)} Gateway lock record(s) held by stopped pod ${hosts.join(", ")}`);
  return "recovered";
}
