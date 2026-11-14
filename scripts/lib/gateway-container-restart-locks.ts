import { promises as fs } from "node:fs";
import path from "node:path";

import { dualReadGatewayClassValue } from "@octogee/shared/types/glm";
import { inspectGatewayLocks, parseGatewayLockHolder, recoverInspectedGatewayLocks } from "./gateway-lock-recovery.js";
import type { OpenClawCommand } from "./openclaw-cli.js";
import { clusterIsolatedGateway, openclawStateRoot } from "./openclaw-state-store.js";

const RECORD_FILE = ".gateway-container-pid-namespaces.json";
const PID_NAMESPACE = /^\d+$/u;

interface GatewayContainerNamespaces {
  host: string;
  pidNamespaces: string[];
}

function gatewayRunsInPod(env: NodeJS.ProcessEnv): boolean {
  return dualReadGatewayClassValue(env.GATEWAY_CLASS) === "shared" || clusterIsolatedGateway(env);
}

async function readNamespaces(file: string): Promise<GatewayContainerNamespaces | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const unreadable = (reason: string, cause?: unknown) =>
    new Error(`Gateway container PID namespace record ${file} is unreadable: ${reason}`, cause === undefined ? undefined : { cause });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw unreadable(error instanceof Error ? error.message : String(error), error);
  }
  const { host, pidNamespaces } = (parsed ?? {}) as Partial<GatewayContainerNamespaces>;
  if (typeof host !== "string" || !Array.isArray(pidNamespaces) ||
      !pidNamespaces.every((namespace) => typeof namespace === "string" && PID_NAMESPACE.test(namespace))) {
    throw unreadable("unexpected shape");
  }
  return { host, pidNamespaces };
}

async function writeNamespaces(file: string, record: GatewayContainerNamespaces): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function recoverRestartedGatewayContainerLocks(input: {
  env: NodeJS.ProcessEnv;
  hostname: string;
  pidNamespace: string;
  run: OpenClawCommand;
  log: (message: string) => void;
}): Promise<"not-a-pod" | "first-start" | "absent" | "held" | "recovered"> {
  if (!gatewayRunsInPod(input.env)) return "not-a-pod";
  if (!PID_NAMESPACE.test(input.pidNamespace)) throw new Error(`Gateway container PID namespace ${input.pidNamespace} is not an inode number`);
  const file = path.join(openclawStateRoot(input.env), RECORD_FILE);
  const record = await readNamespaces(file);
  const earlier = record?.host === input.hostname
    ? record.pidNamespaces.filter((namespace) => namespace !== input.pidNamespace)
    : [];
  await writeNamespaces(file, { host: input.hostname, pidNamespaces: [...earlier, input.pidNamespace] });
  if (!earlier.length) {
    input.log(`[gateway-container] pod ${input.hostname}: recorded gateway container PID namespace ${input.pidNamespace}`);
    return "first-start";
  }
  const inspection = await inspectGatewayLocks(input.run, input.env);
  if (!inspection.present) return "absent";
  const unproven = inspection.holders.filter((holder) => {
    const parsed = parseGatewayLockHolder(holder);
    return parsed?.host !== input.hostname || parsed.pidNamespace === null || !earlier.includes(parsed.pidNamespace);
  });
  if (unproven.length) {
    input.log(`[gateway-container] pod ${input.hostname}: leaving Gateway lock records to OpenClaw; holder not proven to be an earlier gateway container of this pod: ${unproven.join(" | ")}`);
    return "held";
  }
  const removed = await recoverInspectedGatewayLocks(input.run, input.env, inspection.confirmation);
  input.log(`[gateway-container] recovered ${removed} Gateway lock record(s) held by earlier gateway container(s) of pod ${input.hostname}`);
  return "recovered";
}
