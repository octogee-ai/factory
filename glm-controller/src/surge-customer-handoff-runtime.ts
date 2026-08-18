import { randomBytes } from "node:crypto";
import {
  type FlushGatewayResponse,
  type MigrationConfigTransferMode,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  SIGNATURE_HEADER,
  type PrepareRsyncImportResponse,
} from "@octogee/shared/types/fleet-controller";
import { signFleetRequest } from "@octogee/core/fleet-signature";
import { isValidUsername } from "@octogee/shared/types/identity";
import {
  type SurgeCustomerHandoffDeps,
  type SurgePod,
  type SurgePodHealth,
  type SurgePodSnapshot,
  type SurgePrelaunchState,
} from "./surge-customer-handoff.js";

interface KubectlResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SurgeKubectl = (args: string[]) => Promise<KubectlResult>;

interface PodList {
  items?: Array<{
    metadata?: {
      uid?: string;
      name?: string;
      deletionTimestamp?: string;
    };
    status?: {
      phase?: string;
      podIP?: string;
      conditions?: Array<{ type?: string; status?: string }>;
    };
  }>;
}

class SurgePodControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export function parseSurgePodSnapshot(raw: string): SurgePodSnapshot {
  const parsed = JSON.parse(raw) as PodList;
  const observedPodUids: string[] = [];
  const pods: SurgePod[] = [];
  for (const item of parsed.items ?? []) {
    const { uid, name, deletionTimestamp } = item.metadata ?? {};
    const { phase, podIP, conditions } = item.status ?? {};
    if (uid) observedPodUids.push(uid);
    if (phase !== "Running" || !uid || !name || !podIP) continue;
    pods.push({
      uid,
      name,
      podIP,
      ready: (conditions ?? []).some((condition) =>
        condition.type === "Ready" && condition.status === "True"),
      terminating: Boolean(deletionTimestamp),
    });
  }
  return { pods, observedPodUids };
}

export async function listSurgePods(
  runKubectl: SurgeKubectl,
  namespace: string,
  gatewayId: string,
): Promise<SurgePodSnapshot> {
  const result = await runKubectl([
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    `app=octogee-gateway,gateway-instance=${gatewayId}`,
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get surge pods for ${gatewayId} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return parseSurgePodSnapshot(result.stdout);
}

export const POD_SESSION_DIGEST_SCRIPT = [
  'import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";',
  'import { assertConfiguredBuilderPortableStatePlanOnDisk, configuredBuilderPortableStatePlanFromConfig } from "/octogee/scripts/node_modules/@octogee/core/dist/local-coach-wired.js";',
  'const state=process.env.OPENCLAW_STATE_DIR||path.join(process.env.HOME||"/home/node",".openclaw"),slug=process.argv[1],mode=process.argv[2];',
  'const walk=(dir,prefix="")=>{if(!fs.existsSync(dir))return [];const root=fs.lstatSync(dir);if(root.isSymbolicLink()||!root.isDirectory())throw new Error(`non-regular durable state path: ${prefix||"."}`);const out=[];for(const item of fs.readdirSync(dir,{withFileTypes:true})){const relative=prefix?path.join(prefix,item.name):item.name,abs=path.join(dir,item.name),stat=fs.lstatSync(abs);if(stat.isSymbolicLink())out.push([relative,abs,"link"]);else if(stat.isDirectory())out.push(...walk(abs,relative));else if(stat.isFile())out.push([relative,abs,"file"]);else throw new Error(`non-regular durable state path: ${relative}`);}return out;};',
  'let files;if(mode==="configured-builder-system-config"){const configPath=process.env.OPENCLAW_CONFIG_PATH||path.join(state,"openclaw.json");let config;try{config=JSON.parse(fs.readFileSync(configPath,"utf8"));}catch(error){throw new Error(`cannot read configured Builder config: ${error instanceof Error?error.message:String(error)}`);}const plan=configuredBuilderPortableStatePlanFromConfig(config,state);assertConfiguredBuilderPortableStatePlanOnDisk(state,plan);files=plan.paths.flatMap((item)=>{const absolute=path.join(state,item.relativePath);if(!fs.existsSync(absolute))return [];const stat=fs.lstatSync(absolute);if(item.kind==="directory"){if(!stat.isDirectory())throw new Error(`configured Builder durable state directory is not a directory: ${item.relativePath}`);return walk(absolute,item.relativePath);}if(!stat.isFile())throw new Error(`configured Builder durable state file is not a file: ${item.relativePath}`);return [[item.relativePath,absolute,"file"]];});}else{const root=path.join(state,"agents",`octogee-${slug}-coach`,"sessions");files=walk(root,path.join("agents",`octogee-${slug}-coach`,`sessions`));}',
  'files.sort(([left],[right])=>left.localeCompare(right));const hash=crypto.createHash("sha256");let totalBytes=0;',
  'for(const [relative,absolute,kind] of files){const contents=kind==="link"?Buffer.from(`symlink:${fs.readlinkSync(absolute)}`):fs.readFileSync(absolute);totalBytes+=contents.byteLength;hash.update(relative.split(path.sep).join("/"));hash.update("\\0");hash.update(contents);hash.update("\\0");}',
  'process.stdout.write(JSON.stringify({fileCount:files.length,totalBytes,sha256:hash.digest("hex")}));',
].join("");

interface SessionDigest {
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

function parseSessionDigest(value: unknown, context: string): SessionDigest {
  const digest = value as Partial<SessionDigest> | null;
  if (
    !digest ||
    !Number.isSafeInteger(digest.fileCount) ||
    (digest.fileCount as number) < 0 ||
    !Number.isSafeInteger(digest.totalBytes) ||
    (digest.totalBytes as number) < 0 ||
    typeof digest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest.sha256)
  ) {
    throw new Error(`${context}: invalid durable session digest`);
  }
  return {
    fileCount: digest.fileCount as number,
    totalBytes: digest.totalBytes as number,
    sha256: digest.sha256,
  };
}

export async function readPodDurableSessionDigest(
  runKubectl: SurgeKubectl,
  namespace: string,
  pod: SurgePod,
  slug: string,
  configTransferMode: MigrationConfigTransferMode = "activation-manifest",
): Promise<{ fileCount: number; totalBytes: number; sha256: string }> {
  if (!isValidUsername(slug)) throw new Error(`invalid customer slug for session digest: ${slug}`);
  const result = await runKubectl([
    "-n",
    namespace,
    "exec",
    `pod/${pod.name}`,
    "-c",
    "gateway",
    "--",
    "node",
    "--input-type=module",
    "-e",
    POD_SESSION_DIGEST_SCRIPT,
    slug,
    configTransferMode,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl session digest pod=${pod.name} slug=${slug} failed: ` +
      `${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`kubectl session digest pod=${pod.name} slug=${slug}: invalid JSON`);
  }
  return parseSessionDigest(parsed, `pod=${pod.name} slug=${slug}`);
}

function podBaseUrl(pod: SurgePod): string {
  const host = pod.podIP.includes(":") ? `[${pod.podIP}]` : pod.podIP;
  return `http://${host}:3003`;
}

async function responseJson(response: Response, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    let code: string | null = null;
    try {
      const body = JSON.parse(text) as { code?: unknown };
      if (typeof body.code === "string") code = body.code;
    } catch {}
    throw new SurgePodControlError(`${context}: ${response.status} ${text}`, response.status, code);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${context}: invalid JSON response`);
  }
}

async function postSigned(
  opts: {
    fetch: typeof globalThis.fetch;
    privateKey: string;
    pod: SurgePod;
    gatewayId: string;
    path: string;
    operationId: string;
    body: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const rawBody = JSON.stringify(opts.body);
  const response = await opts.fetch(
    `${podBaseUrl(opts.pod)}/${opts.path}/${encodeURIComponent(opts.gatewayId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(opts.privateKey, opts.operationId, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(330_000),
    },
  );
  return responseJson(response, `${opts.path} pod=${opts.pod.name}`);
}

export interface SurgePodTransportOptions {
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  randomKey?: () => string;
  log: (message: string) => void;
}

export type SurgePodTransport = Pick<
  SurgeCustomerHandoffDeps,
  | "readPodHealth"
  | "quiesce"
  | "stopSourceOpenClaw"
  | "resumeSourceOpenClaw"
  | "holdTargetOpenClaw"
  | "unreserveTargetOpenClaw"
  | "flush"
  | "transfer"
  | "discardTargetCustomer"
  | "releaseTarget"
>;

const SURGE_PRELAUNCH_STATES: readonly SurgePrelaunchState[] = [
  "none",
  "held",
  "hydrated",
  "starting",
  "serving",
];

// A pod that predates the process gate omits the field; anything else must be
// a known state or the whole health read is invalid.
function parsePrelaunchState(value: unknown): SurgePrelaunchState | null {
  if (value === undefined) return "none";
  return (SURGE_PRELAUNCH_STATES as readonly unknown[]).includes(value)
    ? value as SurgePrelaunchState
    : null;
}

type SurgeControlCall = (
  pod: SurgePod,
  gatewayId: string,
  path: string,
  operationId: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface SurgeTransferRuntime {
  control: SurgeControlCall;
  randomKey: () => string;
  log: (message: string) => void;
}

type SurgeTransferInput = Parameters<SurgeCustomerHandoffDeps["transfer"]>[0];

async function abortTargetImport(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
  mode: "keys" | "final",
): Promise<void> {
  const { gatewayId, slug, operationId, targetPod, configTransferMode } = input;
  await runtime.control(targetPod, gatewayId, "abort-rsync-import", operationId, {
    migrationId: operationId,
    slug,
    rpcPhase: "abort-rsync-import",
    mode,
    ...(mode === "final" ? { configTransferMode } : {}),
  }).catch((abortError) => {
    runtime.log(
      `[surge-handoff] abort failed pod=${targetPod.name} slug=${slug}: ` +
      `${abortError instanceof Error ? abortError.message : String(abortError)}`,
    );
  });
}

async function transferMode(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
  mode: "keys" | "final",
): Promise<void> {
  const { gatewayId, slug, operationId, sourcePod, targetPod, loadStrategy, configTransferMode } = input;
  const transferKey = runtime.randomKey();
  let prepared = false;
  try {
    const prepare = await runtime.control(targetPod, gatewayId, "prepare-rsync-import", operationId, {
      migrationId: operationId,
      slug,
      rpcPhase: "prepare-rsync-import",
      mode,
      transferUser: "migration",
      transferKey,
      sourcePodIp: sourcePod.podIP,
      ...(mode === "final" ? { configTransferMode } : {}),
    }) as unknown as PrepareRsyncImportResponse;
    if (!Number.isInteger(prepare.port) || prepare.port <= 0) {
      throw new Error(`target pod ${targetPod.name} returned invalid rsync port`);
    }
    prepared = true;
    await runtime.control(sourcePod, gatewayId, "push-rsync-state", operationId, {
      migrationId: operationId,
      slug,
      rpcPhase: "push-rsync-state",
      mode,
      targetHost: targetPod.podIP,
      targetPort: prepare.port,
      transferUser: "migration",
      transferKey,
      ...(mode === "final"
        ? {
          configTransferMode,
          ...(configTransferMode === "activation-manifest" ? { includeActivationManifest: true } : {}),
        }
        : {}),
    });
    await runtime.control(targetPod, gatewayId, "finish-rsync-import", operationId, {
      migrationId: operationId,
      slug,
      rpcPhase: "finish-rsync-import",
      mode,
      ...(mode === "final" ? { loadStrategy, configTransferMode } : {}),
    });
  } catch (error) {
    if (prepared) await abortTargetImport(runtime, input, mode);
    throw error;
  }
}

async function transferCustomerState(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
): Promise<void> {
  const { gatewayId, slug, operationId, targetPod, configTransferMode, expectedSystemConfigCommit } = input;
  if (configTransferMode === "configured-builder-system-config" && !expectedSystemConfigCommit) {
    throw new Error(`configured Builder transfer is missing system config commit for ${slug}`);
  }
  await transferMode(runtime, input, "keys");
  if (configTransferMode === "configured-builder-system-config") {
    try {
      await runtime.control(targetPod, gatewayId, "flush", operationId, {
        migrationId: operationId,
        slug,
        reason: "migration-converge",
        expectedSystemConfigCommit: expectedSystemConfigCommit!,
      });
    } catch (error) {
      await abortTargetImport(runtime, input, "final");
      throw error;
    }
  }
  await transferMode(runtime, input, "final");
}

export function createSurgePodTransport(opts: SurgePodTransportOptions): SurgePodTransport {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const randomKey = opts.randomKey ?? (() => randomBytes(32).toString("hex"));

  const control = (
    pod: SurgePod,
    gatewayId: string,
    path: string,
    operationId: string,
    body: Record<string, unknown>,
  ) => postSigned({
    fetch: fetchImpl,
    privateKey: opts.privateKey,
    pod,
    gatewayId,
    path,
    operationId,
    body,
  });

  const openClawProcessControl = async (input: {
    pod: SurgePod;
    gatewayId: string;
    path: "hold-surge-openclaw" | "resume-surge-openclaw" | "unreserve-surge-openclaw";
    operationId: string;
    slug: string;
    targetPodUid: string;
    capability: string;
  }): Promise<void> => {
    try {
      await control(input.pod, input.gatewayId, input.path, input.operationId, {
        migrationId: input.operationId,
        slug: input.slug,
        targetPodUid: input.targetPodUid,
      });
    } catch (error) {
      if (error instanceof SurgePodControlError && error.status === 404) {
        throw new Error(
          `pod ${input.pod.name} lacks the required surge OpenClaw ${input.capability} endpoint`,
          { cause: error },
        );
      }
      throw error;
    }
  };

  return {
    async readPodHealth(pod): Promise<SurgePodHealth | null> {
      try {
        const [healthResponse, readyResponse] = await Promise.all([
          fetchImpl(`${podBaseUrl(pod)}/health`, { signal: AbortSignal.timeout(5_000) }),
          fetchImpl(`${podBaseUrl(pod)}/surge-ready`, { signal: AbortSignal.timeout(5_000) }),
        ]);
        const health = await responseJson(healthResponse, `health pod=${pod.name}`);
        const ready = await readyResponse.json() as Record<string, unknown>;
        const prelaunchState = parsePrelaunchState(ready.prelaunchState);
        if (
          (health.status !== "booting" && health.status !== "ready") ||
          typeof health.version !== "string" ||
          !Array.isArray(health.customers) ||
          !health.customers.every((slug) => typeof slug === "string") ||
          typeof ready.handoffReleased !== "boolean" ||
          typeof ready.openclawUp !== "boolean" ||
          prelaunchState === null
        ) {
          throw new Error(`invalid surge health response from pod=${pod.name}`);
        }
        return {
          status: ready.openclawUp ? "ready" : "booting",
          version: health.version,
          handoffReleased: ready.handoffReleased,
          prelaunchState,
          mountedCustomers: [...new Set(health.customers as string[])],
        };
      } catch (error) {
        opts.log(
          `[surge-handoff] pod=${pod.name} health unavailable: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },

    async quiesce({ gatewayId, slug, operationId, sourcePod }) {
      await control(sourcePod, gatewayId, "quiesce", operationId, {
        migrationId: operationId,
        slug,
        timeoutMs: MIGRATION_QUIESCE_TIMEOUT_MS,
      });
    },

    async stopSourceOpenClaw({ gatewayId, slug, operationId, sourcePod, targetPod }) {
      await openClawProcessControl({
        pod: sourcePod,
        gatewayId,
        path: "hold-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "hold",
      });
    },

    async resumeSourceOpenClaw({ gatewayId, slug, operationId, sourcePod, targetPod }) {
      await openClawProcessControl({
        pod: sourcePod,
        gatewayId,
        path: "resume-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "resume",
      });
    },

    async holdTargetOpenClaw({ gatewayId, slug, operationId, targetPod }) {
      await openClawProcessControl({
        pod: targetPod,
        gatewayId,
        path: "hold-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "reserve",
      });
    },

    async unreserveTargetOpenClaw({ gatewayId, slug, operationId, targetPod }) {
      await openClawProcessControl({
        pod: targetPod,
        gatewayId,
        path: "unreserve-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "unreserve",
      });
    },

    async flush({
      gatewayId,
      slug,
      operationId,
      pod,
      reason,
      expectedSystemConfigCommit,
    }) {
      const response = await control(pod, gatewayId, "flush", operationId, {
        migrationId: operationId,
        slug,
        reason,
        ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
      }) as unknown as FlushGatewayResponse;
      return {
        ...(typeof response.systemConfigCommit === "string"
          ? { systemConfigCommit: response.systemConfigCommit }
          : {}),
      };
    },

    transfer: (input) => transferCustomerState({ control, randomKey, log: opts.log }, input),
    async discardTargetCustomer({ gatewayId, slug, operationId, targetPod }) {
      const unmount = () => control(
        targetPod,
        gatewayId,
        "unmount",
        operationId,
        {
          migrationId: operationId,
          slug,
        },
      );
      try {
        await unmount();
      } catch (error) {
        if (!(error instanceof SurgePodControlError) || error.code !== "hash-mismatch") {
          throw error;
        }
        opts.log(
          `[surge-handoff] target cleanup lost config CAS pod=${targetPod.name} slug=${slug}; retrying signed unmount once`,
        );
        await unmount();
      }
    },

    async releaseTarget({ gatewayId, operationId, pod }) {
      await control(pod, gatewayId, "complete-surge-handoff", operationId, {
        migrationId: operationId,
        targetPodUid: pod.uid,
      });
    },
  };
}
