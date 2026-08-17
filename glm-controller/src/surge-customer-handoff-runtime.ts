import { randomBytes } from "node:crypto";
import {
  MIGRATION_QUIESCE_TIMEOUT_MS,
  SIGNATURE_HEADER,
  type PrepareRsyncImportResponse,
} from "@octogee/shared/types/fleet-controller";
import { signFleetRequest } from "@octogee/core/fleet-signature";
import { isValidUsername } from "@octogee/shared/types/identity";
import type {
  SurgeCustomerHandoffDeps,
  SurgePod,
  SurgePodHealth,
  SurgePodSnapshot,
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

const POD_SESSION_DIGEST_SCRIPT = [
  'const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");',
  'const root=path.join(process.env.OPENCLAW_STATE_DIR||path.join(process.env.HOME||"/home/node",".openclaw"),"agents",`octogee-${process.argv[1]}-coach`,"sessions");',
  'const walk=(dir,rel="")=>{if(!fs.existsSync(dir))return [];const out=[];for(const item of fs.readdirSync(dir,{withFileTypes:true})){const child=rel?path.join(rel,item.name):item.name;const abs=path.join(dir,item.name);if(item.isDirectory())out.push(...walk(abs,child));else if(item.isFile())out.push(child);else throw new Error(`non-regular session path: ${child}`);}return out;};',
  'const files=walk(root).sort((a,b)=>a.localeCompare(b)),hash=crypto.createHash("sha256");let totalBytes=0;',
  'for(const relative of files){const contents=fs.readFileSync(path.join(root,relative));totalBytes+=contents.byteLength;hash.update(relative.split(path.sep).join("/"));hash.update("\\0");hash.update(contents);hash.update("\\0");}',
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
    "-e",
    POD_SESSION_DIGEST_SCRIPT,
    slug,
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
  | "transfer"
  | "discardTargetCustomer"
  | "releaseTarget"
>;

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

  return {
    async readPodHealth(pod): Promise<SurgePodHealth | null> {
      try {
        const [healthResponse, readyResponse] = await Promise.all([
          fetchImpl(`${podBaseUrl(pod)}/health`, { signal: AbortSignal.timeout(5_000) }),
          fetchImpl(`${podBaseUrl(pod)}/surge-ready`, { signal: AbortSignal.timeout(5_000) }),
        ]);
        const health = await responseJson(healthResponse, `health pod=${pod.name}`);
        const ready = await readyResponse.json() as Record<string, unknown>;
        if (
          (health.status !== "booting" && health.status !== "ready") ||
          typeof health.version !== "string" ||
          !Array.isArray(health.customers) ||
          !health.customers.every((slug) => typeof slug === "string") ||
          typeof ready.handoffReleased !== "boolean" ||
          typeof ready.openclawUp !== "boolean"
        ) {
          throw new Error(`invalid surge health response from pod=${pod.name}`);
        }
        return {
          status: ready.openclawUp ? "ready" : "booting",
          version: health.version,
          handoffReleased: ready.handoffReleased,
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

    async transfer({ gatewayId, slug, operationId, sourcePod, targetPod, loadStrategy }) {
      const transferMode = async (mode: "keys" | "final") => {
        const transferKey = randomKey();
        let prepared = false;
        try {
          const prepare = await control(
            targetPod,
            gatewayId,
            "prepare-rsync-import",
            operationId,
            {
              migrationId: operationId,
              slug,
              rpcPhase: "prepare-rsync-import",
              mode,
              transferUser: "migration",
              transferKey,
              sourcePodIp: sourcePod.podIP,
            },
          ) as unknown as PrepareRsyncImportResponse;
          if (!Number.isInteger(prepare.port) || prepare.port <= 0) {
            throw new Error(`target pod ${targetPod.name} returned invalid rsync port`);
          }
          prepared = true;
          await control(sourcePod, gatewayId, "push-rsync-state", operationId, {
            migrationId: operationId,
            slug,
            rpcPhase: "push-rsync-state",
            mode,
            targetHost: targetPod.podIP,
            targetPort: prepare.port,
            transferUser: "migration",
            transferKey,
            ...(mode === "final" ? { includeActivationManifest: true } : {}),
          });
          await control(targetPod, gatewayId, "finish-rsync-import", operationId, {
            migrationId: operationId,
            slug,
            rpcPhase: "finish-rsync-import",
            mode,
            ...(mode === "final" ? { loadStrategy } : {}),
          });
        } catch (error) {
          if (prepared) {
            await control(targetPod, gatewayId, "abort-rsync-import", operationId, {
              migrationId: operationId,
              slug,
              rpcPhase: "abort-rsync-import",
              mode,
            }).catch((abortError) => {
              opts.log(
                `[surge-handoff] abort failed pod=${targetPod.name} slug=${slug}: ` +
                `${abortError instanceof Error ? abortError.message : String(abortError)}`,
              );
            });
          }
          throw error;
        }
      };

      await transferMode("keys");
      await transferMode("final");
    },

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
