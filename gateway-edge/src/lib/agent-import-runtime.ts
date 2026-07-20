import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { generateIdentity, type DeviceIdentity } from "@octogee/shared/types/device-identity";

import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { fetchGatewayAuth, persistGatewayDeviceToken } from "../chat-proxy/openclaw/gateway-token.js";
import { openUpstream } from "../chat-proxy/openclaw/upstream.js";
import { db, storage } from "./db.js";
import { readConnectorAccessToken } from "./connector-tokens.js";
import { githubListRepos } from "./github.js";
import { readAgent } from "./firestoreReads.js";
import { syncCoachIdentity } from "./coach-identity.js";
import { createAgentImportStore } from "./agent-import-store.js";
import {
  applyAgentImportRepository,
  inspectAgentImportRepository,
  rollbackAgentImportRepository,
  type AgentImportManifestEntry,
} from "./agent-import-git.js";
import { cloneGithubAgentImportSource, extractLocalAgentImportArchive } from "./agent-import-source.js";
import {
  AgentImportService,
  type AgentImportDoctorResult,
  type AgentImportIdentity,
} from "./agent-import-service.js";

type JsonObject = Record<string, unknown>;

interface DoctorClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function doctorResult(value: unknown): AgentImportDoctorResult {
  const result = object(value);
  const outcomes = new Set(["unchanged", "migrated", "unsupported", "failed"]);
  if (
    !result || typeof result.outcome !== "string" || !outcomes.has(result.outcome) ||
    typeof result.doctorVersion !== "string" || !Array.isArray(result.changedPaths) ||
    !result.changedPaths.every((item) => typeof item === "string") ||
    !Array.isArray(result.diagnostics) || !result.diagnostics.every((item) => typeof item === "string") ||
    (result.repairedCandidate !== undefined && !object(result.repairedCandidate))
  ) {
    throw new Error("agent import doctor returned an invalid result");
  }
  return result as unknown as AgentImportDoctorResult;
}

export function createAgentImportDoctorClient(options: DoctorClientOptions) {
  const url = new URL("/agent-import/doctor", options.baseUrl).toString();
  return async (candidate: JsonObject): Promise<AgentImportDoctorResult> => {
    if (!options.token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required for agent import doctor");
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ candidate }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`agent import doctor rejected candidate (${response.status})`);
    return doctorResult(await response.json());
  };
}

function git(targetDir: string, args: string[]): string {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: targetDir,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`workspace git inspection failed (exit ${String(result.status)})`);
  }
  return (result.stdout ?? "").trim();
}

export function readAgentImportWorkspaceState(
  slug: string,
  options: { customersRoot?: string; targetDir?: string } = {},
): { targetDir: string; head: string; clean: boolean } {
  const targetDir = options.targetDir ?? path.join(
    options.customersRoot ?? process.env.CUSTOMERS_DIR ?? "/home/node/.openclaw/customers",
    slug,
  );
  const branch = git(targetDir, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") throw new Error("workspace import requires the main branch");
  return {
    targetDir,
    head: git(targetDir, ["rev-parse", "HEAD"]),
    clean: git(targetDir, ["status", "--porcelain", "--untracked-files=all"]) === "",
  };
}

interface ImportBlobBucket {
  file(path: string): {
    save(contents: Buffer, options: { metadata: { contentType: string } }): Promise<unknown>;
  };
}

export async function storeAgentImportBlob(
  bucket: ImportBlobBucket,
  slug: string,
  importId: string,
  filePath: string,
  contents: Buffer,
  mimeType: string,
  now = new Date(),
): Promise<AgentImportManifestEntry> {
  const gcsPath = `customers/${slug}/agent-imports/${importId}/${filePath}`;
  await bucket.file(gcsPath).save(contents, { metadata: { contentType: mimeType } });
  return {
    type: "blob",
    gcsPath,
    size: contents.length,
    mimeType,
    uploadedAt: now.toISOString(),
  };
}

let runtimeIdentity: DeviceIdentity | null = null;

async function invokeLocalOpenClaw(method: string, params: JsonObject): Promise<unknown> {
  const gatewayId = process.env.GATEWAY_ID ?? "";
  const auth = await fetchGatewayAuth({ gatewayId, allowLegacyFallback: true });
  runtimeIdentity ??= generateIdentity();
  const ws = await openUpstream({
    url: process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
    token: auth.token,
    deviceToken: auth.deviceToken,
    identity: runtimeIdentity,
    onDeviceToken: async (issued) => persistGatewayDeviceToken({ token: issued.deviceToken }),
  });
  const rpc = attachUpstreamRpcClient(ws, { timeoutMs: 30_000 });
  try {
    const result = await rpc.call(method, params);
    if (!result.ok) throw new Error(`agent import ${method} failed: ${result.reason}`);
    return result.result;
  } finally {
    rpc.dispose();
    ws.close();
  }
}

async function withConfigLock<T>(work: () => Promise<T>): Promise<T> {
  const lease = await acquireSystemConfigMutationLease({
    openclawDir: process.env.OPENCLAW_DIR ?? "/home/node/.openclaw",
  });
  if (!lease.ok) throw new Error("system config writer lock is busy");
  try {
    return await work();
  } finally {
    await lease.lease.release();
  }
}

async function readIdentity(uid: string): Promise<AgentImportIdentity> {
  const agent = await readAgent(uid);
  return agent ? {
    ...(agent.name ? { name: agent.name } : {}),
    ...(typeof agent.persona === "string" ? { persona: agent.persona } : {}),
    ...(typeof agent.avatarEmoji === "string" ? { emoji: agent.avatarEmoji } : {}),
  } : {};
}

async function isProvisioned(uid: string): Promise<boolean> {
  const snapshot = await db.doc(`users/${uid}`).get();
  const user = object(snapshot.data());
  const provisioning = object(user?.provisioning);
  return object(provisioning?.openclaw)?.status === "complete";
}

async function listGithubSources(uid: string): Promise<unknown> {
  const token = await readConnectorAccessToken(uid, "github");
  if (!token) return Promise.reject(Object.assign(new Error("GitHub not connected"), { status: 422, code: "github_not_connected" }));
  return githubListRepos(token);
}

export function createAgentImportRuntime() {
  const bucket = storage.bucket();
  const store = createAgentImportStore({ db, bucket });
  const runDoctor = createAgentImportDoctorClient({
    baseUrl: `http://127.0.0.1:${process.env.FLEET_CONTROLLER_PORT ?? "3003"}`,
    token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
  });
  const service = new AgentImportService({
    newId: randomUUID,
    now: () => new Date(),
    readGithubToken: (uid) => readConnectorAccessToken(uid, "github"),
    cloneGithubSource: cloneGithubAgentImportSource,
    extractLocalSource: extractLocalAgentImportArchive,
    inspectSource: inspectAgentImportRepository,
    workspaceState: (slug) => readAgentImportWorkspaceState(slug),
    runDoctor,
    ...store,
    applyRepository: (input) => applyAgentImportRepository({
      ...input,
      storeBlob: (filePath, contents, mimeType) => storeAgentImportBlob(
        bucket,
        input.slug,
        input.importId,
        filePath,
        contents,
        mimeType,
      ),
    }),
    rollbackRepository: rollbackAgentImportRepository,
    readIdentity,
    syncIdentity: async (uid, identity) => {
      await syncCoachIdentity(uid, {
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.persona !== undefined ? { persona: identity.persona } : {}),
        ...(identity.emoji ? { emoji: identity.emoji } : {}),
      });
    },
    withConfigLock,
    invokeOpenClaw: invokeLocalOpenClaw,
  });
  return { service, isProvisioned, listGithubSources };
}
