import { randomUUID } from "node:crypto";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";

export const MAX_LOAD_RUN_MS = 30 * 60_000;
const testTarget = deploymentEnvironmentSettings("test");
export const TEST_API_ORIGIN = testTarget.apiOrigin;
export const TEST_APP_ORIGIN = testTarget.appOrigin;
export const TEST_FIREBASE_PROJECT = testTarget.firebaseProjectId;
export const TEST_CONTEXT = testTarget.kubeContext;
export const TEST_NAMESPACE = testTarget.namespace;
// Numbered slots predate the scaler; it mints shared-<12 hex> (glm-controller shared-pool-scaler).
export const SHARED_SLOT_RE = /^shared-(?:\d+|[a-f0-9]{12})$/;

export interface LoadTarget {
  name: string;
  workspaceSlug: string;
  tokenEnv: string;
  channelId: string;
}

export interface LoadPlan {
  gatewayId: string;
  targets: LoadTarget[];
  readConcurrency: number[];
  defaultAgentConcurrency: number[];
  readRounds: number;
  maxDefaultAgentTurns: number;
  turnTimeoutMs: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function concurrency(value: unknown, count: number, field: string): number[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error(`${field} must contain at most 8 stages`);
  return value.map((n) => integer(n, 1, count, field));
}

function parseTargets(input: unknown): LoadTarget[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new Error("Provide 1–64 TEST targets");
  const targets = input.map((raw): LoadTarget => {
    const t = object(raw);
    if (Object.keys(t).some((key) => !["name", "workspaceSlug", "tokenEnv", "channelId"].includes(key))) throw new Error("Unknown target field; put tokens in environment variables");
    for (const key of ["name", "workspaceSlug"] as const) {
      if (typeof t[key] !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(t[key])) throw new Error(`Invalid target ${key}`);
    }
    if (typeof t.tokenEnv !== "string" || !/^OCTOGEE_LOAD_TOKEN_[A-Z0-9_]+$/.test(t.tokenEnv)) throw new Error("Invalid tokenEnv");
    if (typeof t.channelId !== "string" || !/^[a-z0-9]{26}$/.test(t.channelId)) {
      throw new Error("Use a Mattermost channelId for a dedicated TEST channel");
    }
    return t as unknown as LoadTarget;
  });
  for (const key of ["name", "workspaceSlug", "tokenEnv", "channelId"] as const) {
    if (new Set(targets.map((t) => t[key])).size !== targets.length) throw new Error(`Targets must have distinct ${key}`);
  }
  return targets;
}

export function parseLoadPlan(input: unknown): LoadPlan {
  const plan = object(input);
  if (Object.keys(plan).some((key) => ![
    "gatewayId", "targets", "readConcurrency", "defaultAgentConcurrency", "readRounds", "maxDefaultAgentTurns", "turnTimeoutMs",
  ].includes(key))) throw new Error("Unknown plan field; API origin and namespace cannot be overridden");
  if (typeof plan.gatewayId !== "string" || !SHARED_SLOT_RE.test(plan.gatewayId)) throw new Error("Expected a shared gateway ID");
  const targets = parseTargets(plan.targets);
  const readConcurrency = concurrency(plan.readConcurrency ?? [1, Math.min(2, targets.length), targets.length], targets.length, "readConcurrency");
  const defaultAgentConcurrency = concurrency(plan.defaultAgentConcurrency ?? [], targets.length, "defaultAgentConcurrency");
  const maxDefaultAgentTurns = integer(plan.maxDefaultAgentTurns ?? 0, 0, 64, "maxDefaultAgentTurns");
  if (defaultAgentConcurrency.reduce((a, b) => a + b, 0) > maxDefaultAgentTurns) throw new Error("Agent stages exceed maxDefaultAgentTurns");
  if (readConcurrency.length + defaultAgentConcurrency.length === 0) throw new Error("At least one stage is required");
  return {
    gatewayId: plan.gatewayId, targets, readConcurrency, defaultAgentConcurrency, maxDefaultAgentTurns,
    readRounds: integer(plan.readRounds ?? 2, 1, 5, "readRounds"),
    turnTimeoutMs: integer(plan.turnTimeoutMs ?? 120_000, 1_000, 180_000, "turnTimeoutMs"),
  };
}

export interface LoadClient {
  read(): Promise<unknown>;
  send(message: string, idempotencyKey: string): Promise<void>;
  close(): void;
}

export class LoadHttpError extends Error {
  constructor(readonly httpStatus: number) { super(`Load HTTP ${httpStatus}`); }
}

export interface LoadMeasurement {
  at: string;
  stage: string;
  target: string;
  operation: "connect" | "read" | "reconnect" | "send_ack" | "coach_complete";
  durationMs: number;
  ok: boolean;
  failure?: { code: "http" | "cancelled" | "operation-failed"; httpStatus?: number };
}

export function hasDefaultAgentReply(history: unknown, marker: string): boolean {
  const messages = object(history).messages;
  if (!Array.isArray(messages)) throw new Error("Invalid chat history response");
  return messages.some((raw) => {
    const message = object(raw);
    if (message.role !== "assistant") return false;
    const content = message.content;
    return typeof content === "string" ? content.trim() === marker : Array.isArray(content)
      && content.some((part) => typeof part?.text === "string" && part.text.trim() === marker);
  });
}

export async function runLoadPlan(plan: LoadPlan, deps: {
  connect(target: LoadTarget, signal: AbortSignal): Promise<LoadClient>;
  emit(measurement: LoadMeasurement): void;
  signal: AbortSignal;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
}): Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const stop = new AbortController();
  const signal = AbortSignal.any([deps.signal, stop.signal]);
  const clients = new Set<LoadClient>();
  const stages = [
    ...plan.readConcurrency.map((n, index) => ({ n, defaultAgent: false, name: `reads-${index + 1}-${n}` })),
    ...plan.defaultAgentConcurrency.map((n, index) => ({ n, defaultAgent: true, name: `default-agents-${index + 1}-${n}` })),
  ];
  try {
    for (const [index, stage] of stages.entries()) {
      signal.throwIfAborted();
      if (index > 0) await deps.sleep(65_000, signal);
      const tasks = plan.targets.slice(0, stage.n).map(async (target) => {
        const timed = async <T>(operation: LoadMeasurement["operation"], action: () => Promise<T>): Promise<T> => {
          const start = now();
          let ok = false, failure: LoadMeasurement["failure"];
          try { signal.throwIfAborted(); const result = await action(); ok = true; return result; }
          catch (error) {
            failure = error instanceof LoadHttpError ? { code: "http", httpStatus: error.httpStatus }
              : { code: signal.aborted ? "cancelled" : "operation-failed" };
            throw error;
          }
          finally { deps.emit({ at: new Date().toISOString(), stage: stage.name, target: target.name, operation, durationMs: now() - start, ok, ...(failure ? { failure } : {}) }); }
        };
        let client = await timed("connect", () => deps.connect(target, signal));
        clients.add(client);
        try {
          if (!stage.defaultAgent) {
            for (let round = 0; round < plan.readRounds; round++) {
              await timed("read", () => client.read());
              await deps.sleep(1_000, signal);
              await timed("read", () => client.read());
              client.close(); clients.delete(client);
              client = await timed("reconnect", () => deps.connect(target, signal));
              clients.add(client);
              await timed("read", () => client.read());
            }
          } else {
            await timed("coach_complete", () => performDefaultAgentTurn(client, {
              timeoutMs: plan.turnTimeoutMs, signal, now, sleep: deps.sleep,
              send: (message, id) => timed("send_ack", () => client.send(message, id)),
            }));
          }
        } finally { client.close(); clients.delete(client); }
      });
      try { await Promise.all(tasks); }
      catch (error) {
        stop.abort();
        for (const client of clients) client.close();
        await Promise.allSettled(tasks);
        throw error;
      }
    }
  } finally { for (const client of clients) client.close(); }
}

export async function performDefaultAgentTurn(client: LoadClient, opts: {
  timeoutMs: number;
  signal: AbortSignal;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
  pollMs?: number;
  send?: (message: string, idempotencyKey: string) => Promise<void>;
}): Promise<void> {
  const now = opts.now ?? (() => performance.now());
  const send = opts.send ?? ((message, id) => client.send(message, id));
  const pollMs = opts.pollMs ?? 2_000;
  const id = randomUUID();
  const marker = `OCTOGEE_LOAD_${id}`;
  const timeout = setTimeout(() => client.close(), opts.timeoutMs);
  try {
    const deadline = now() + opts.timeoutMs;
    await send(`Capacity test. Reply with exactly ${marker}. Do not use tools or perform any other action.`, id);
    for (;;) {
      opts.signal.throwIfAborted();
      if (now() >= deadline) throw new Error("Agent completion deadline exceeded");
      const history = await client.read();
      if (now() < deadline && hasDefaultAgentReply(history, marker)) return;
      await opts.sleep(Math.min(pollMs, Math.max(0, deadline - now())), opts.signal);
    }
  } finally { clearTimeout(timeout); }
}

export function summarizeMeasurements(measurements: LoadMeasurement[]) {
  const groups = new Map<string, LoadMeasurement[]>();
  for (const row of measurements) {
    const key = `${row.stage}/${row.operation}`;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return [...groups.entries()].map(([operation, rows]) => {
    const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
    const percentile = (p: number) => durations[Math.ceil(durations.length * p) - 1];
    return { operation, count: rows.length, failures: rows.filter((r) => !r.ok).length,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: durations.at(-1) };
  });
}
