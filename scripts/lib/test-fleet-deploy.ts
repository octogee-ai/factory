import { isReleasePayload, releasePayloadHash, type PlatformReleaseRecord, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { SharedPoolReplacement } from "@octogee/shared/types/shared-gateway-pool";

export interface TestFleetContainer {
  name: string;
  image: string;
  digests: string[];
  running: boolean;
}

export interface TestFleetLiveObservation {
  observedAt: number;
  instances: Array<{ id: string; ready: boolean; containers: TestFleetContainer[] }>;
}

export interface TestFleetGateway {
  gatewayId: string;
  gatewayClass: "shared" | "builder";
  imageProfile: "standard" | "builder";
  standby: boolean;
  desiredStatus: "running" | "paused" | "draining" | "retired";
  latestRelease: number;
  desiredRelease: number;
  liveRelease: number | null;
  latestPayload: ReleasePayload | null;
  desiredPayload: ReleasePayload | null;
  assignments: Array<{ slug: string; state: string }>;
  operations: Array<{ id: string; release: number; status: string; error: string | null }>;
  runtime: {
    release: number;
    lifecycle: string;
    status: string;
    heartbeatAt: number | null;
    mountedCustomers: string[];
    migratingIn: string[];
  } | null;
  live: TestFleetLiveObservation | null;
  observationError?: string;
}

export interface TestFleetSnapshot {
  platform: PlatformReleaseRecord | null;
  retirements: Array<{ gatewayId: string; operationId: string; completedAt: number; live: TestFleetLiveObservation }>;
  gateways: TestFleetGateway[];
  sharedReplacements: SharedPoolReplacement[];
}

export interface TestFleetTargetResult {
  gatewayId: string;
  gatewayClass: "shared" | "builder";
  desiredStatus: TestFleetGateway["desiredStatus"];
  desiredRelease: number;
  liveRelease: number | null;
  status: "live" | "paused-desired-only" | "retired-skipped" | "standby-skipped" | "shared-retired" | "waiting" | "failed";
  reasons: string[];
  expectedImages: Record<string, string>;
  observed: TestFleetLiveObservation | null;
  retirementOperationId?: string;
  deployment?: { release: number; operationId: string | null };
}

export interface TestFleetDeployReport {
  environment: "test";
  sourceSha: string;
  outcome: "converged" | "failed" | "timed-out";
  startedAt: number;
  completedAt: number;
  targets: TestFleetTargetResult[];
  reasons: string[];
}

export interface TestFleetDeployOptions {
  environment: string;
  sourceSha: string;
  payload: ReleasePayload;
  timeoutMs: number;
  pollIntervalMs?: number;
  maxObservationAgeMs?: number;
}

export interface TestFleetDeployDeps {
  readSnapshot(): Promise<TestFleetSnapshot>;
  deploy(gateway: TestFleetGateway): Promise<{ release: number; operationId: string | null }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export class TestFleetDeploymentDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestFleetDeploymentDeferredError";
  }
}

function matchesPayload(actual: ReleasePayload | null, expected: ReleasePayload): boolean {
  return actual !== null && isReleasePayload(actual) && releasePayloadHash(actual) === releasePayloadHash(expected);
}

export function expectedTestFleetImages(gateway: Pick<TestFleetGateway, "imageProfile">, payload: ReleasePayload): Record<string, string> {
  const image = gateway.imageProfile === "builder" ? payload.profileImages?.builder : payload;
  if (!image || !payload.gatewayEdgeImage) throw new Error("complete gateway image family is required");
  return { gateway: `${image.imageRepository}:${image.imageTag}`, "gateway-edge": `${payload.gatewayEdgeImage.imageRepository}:${payload.gatewayEdgeImage.imageTag}` };
}

function pinnedImage(reference: string): string | null {
  const match = /^(.*)@(sha256:[a-f0-9]{64})$/.exec(reference);
  return match ? `${match[1].replace(/:[^/:]+$/, "")}@${match[2]}` : null;
}

function retagPayload(payload: ReleasePayload, prefix: string): ReleasePayload {
  const retag = (image: { imageRepository: string; imageTag: string }) => ({ ...image, imageTag: `${prefix}@${image.imageTag.split("@")[1]}` });
  return { ...payload, ...retag(payload),
    ...(payload.profileImages ? { profileImages: { builder: retag(payload.profileImages.builder) } } : {}),
    ...(payload.gatewayEdgeImage ? { gatewayEdgeImage: retag(payload.gatewayEdgeImage) } : {}),
  };
}

function sourceTagMatches(tag: string, sourceSha: string): boolean {
  const prefix = tag.split("@")[0];
  return prefix === sourceSha.slice(0, 7) || prefix.startsWith(`${sourceSha.slice(0, 7)}-oc`);
}

export function matchesTestPlatformRelease(record: PlatformReleaseRecord | null, payload: ReleasePayload, sourceSha: string): boolean {
  if (!record || !sourceTagMatches(record.imageTag, sourceSha) || record.openclawSourceSha !== (payload.openclawSourceSha ?? null)) return false;
  const expected = retagPayload(payload, record.imageTag.split("@")[0]);
  return record.imageTag === expected.imageTag && record.payloadHash === releasePayloadHash(expected);
}

function matchesGatewayPayload(gateway: TestFleetGateway, actual: ReleasePayload | null, options: TestFleetDeployOptions): boolean {
  if (gateway.gatewayClass === "builder") return matchesPayload(actual, options.payload);
  if (!actual || !isReleasePayload(actual) || !actual.profileImages || !actual.gatewayEdgeImage || !sourceTagMatches(actual.imageTag, options.sourceSha)) return false;
  const expected = retagPayload(options.payload, actual.imageTag.split("@")[0]);
  return matchesPayload(actual, expected);
}

type ObservationTiming = { now: number; startedAt: number; maxAge: number };
function fresh(at: number | null, timing: ObservationTiming): boolean {
  return at !== null && Number.isFinite(at) && at >= timing.startedAt && at <= timing.now && timing.now - at <= timing.maxAge;
}

function containerProblems(live: TestFleetLiveObservation, expected: Record<string, string>): string[] {
  const reasons: string[] = [];
  for (const instance of live.instances) {
    if (!instance.ready) reasons.push(`instance ${instance.id} is not ready`);
    for (const [name, image] of Object.entries(expected)) {
      const container = instance.containers.find((candidate) => candidate.name === name);
      if (!container?.running) reasons.push(`${instance.id} ${name} is not running`);
      if (!container || pinnedImage(container.image) !== pinnedImage(image)) reasons.push(`${instance.id} ${name} image reference differs`);
      if (!container?.digests.includes(image.slice(image.lastIndexOf("@") + 1))) reasons.push(`${instance.id} ${name} digest differs`);
    }
  }
  return reasons;
}

function runtimeProblems(gateway: TestFleetGateway, timing: ObservationTiming): string[] {
  const reasons: string[] = [];
  const runtime = gateway.runtime;
  if (gateway.liveRelease !== gateway.desiredRelease || runtime?.release !== gateway.desiredRelease) reasons.push("live release differs from desired release");
  if (runtime?.lifecycle !== "serving" || runtime.status !== "ready") reasons.push("runtime is not serving and ready");
  if (!fresh(runtime?.heartbeatAt ?? null, timing)) reasons.push("heartbeat predates ship or is stale");
  if (gateway.assignments.some((assignment) => assignment.state !== "serving" || !runtime?.mountedCustomers.includes(assignment.slug))) reasons.push("assignments are not all mounted and serving");
  if (runtime?.migratingIn.length) reasons.push("incoming migrations are unfinished");
  return reasons;
}

function runningProblems(gateway: TestFleetGateway, expected: Record<string, string>, timing: ObservationTiming): string[] {
  const reasons = runtimeProblems(gateway, timing);
  const live = gateway.live;
  if (!live || !fresh(live.observedAt, timing)) reasons.push("live observation predates ship or is stale");
  if (!live?.instances.length) reasons.push("no live instance observed");
  if (live) reasons.push(...containerProblems(live, expected));
  if (gateway.observationError) reasons.push(gateway.observationError);
  return reasons;
}

function retiredSharedProblems(gateway: TestFleetGateway, timing: ObservationTiming): string[] {
  const reasons: string[] = [];
  if (gateway.assignments.length) reasons.push("retired Shared member still owns assignments");
  if (!gateway.live || !fresh(gateway.live.observedAt, timing)) reasons.push("retired Shared member removal is not freshly observed");
  if (gateway.live?.instances.length) reasons.push("retired Shared member still has live instances");
  return reasons;
}

function targetAssessment(gateway: TestFleetGateway, options: TestFleetDeployOptions, timing: ObservationTiming): TestFleetTargetResult {
  const result: TestFleetTargetResult = {
    gatewayId: gateway.gatewayId, gatewayClass: gateway.gatewayClass, desiredStatus: gateway.desiredStatus,
    desiredRelease: gateway.desiredRelease, liveRelease: gateway.liveRelease, status: "waiting", reasons: [],
    expectedImages: expectedTestFleetImages(gateway, options.payload), observed: gateway.live,
  };
  if (gateway.standby) return { ...result, status: "standby-skipped" };
  if (gateway.desiredStatus === "retired") {
    result.reasons = gateway.gatewayClass === "shared" ? retiredSharedProblems(gateway, timing) : [];
    if (result.reasons.length === 0) result.status = gateway.gatewayClass === "shared" ? "shared-retired" : "retired-skipped";
    return result;
  }
  const failed = gateway.operations.find((op) => op.release === gateway.latestRelease && op.status === "failed" && matchesGatewayPayload(gateway, gateway.latestPayload, options));
  if (failed) return { ...result, status: "failed", reasons: [`rollout ${failed.id} failed: ${failed.error ?? "unknown error"}`] };
  if (!matchesGatewayPayload(gateway, gateway.desiredPayload, options)) result.reasons.push("desired image family differs from requested build");
  if (gateway.latestRelease !== gateway.desiredRelease) result.reasons.push("latest release is not yet activated");
  if (gateway.desiredStatus === "paused" && gateway.gatewayClass === "builder") {
    if (result.reasons.length === 0) result.status = "paused-desired-only";
    return result;
  }
  if (gateway.desiredStatus !== "running") result.reasons.push(`${gateway.desiredStatus} gateway must finish retirement`);
  result.reasons.push(...runningProblems(gateway, result.expectedImages, timing));
  if (result.reasons.length === 0) result.status = "live";
  return result;
}

function validateOptions(options: TestFleetDeployOptions): void {
  if (options.environment !== "test") throw new Error("complete fleet deployment is TEST only");
  if (!/^[a-f0-9]{40}$/.test(options.sourceSha)) throw new Error("a full lowercase source SHA is required");
  if (!isReleasePayload(options.payload) || !options.payload.profileImages || !options.payload.gatewayEdgeImage) throw new Error("a complete immutable gateway image family is required");
  if ([options.timeoutMs, options.pollIntervalMs ?? 15_000, options.maxObservationAgeMs ?? 180_000].some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error("timeouts must be positive integer milliseconds");
}

interface MutationState {
  attempts: Map<string, TestFleetTargetResult["deployment"]>;
  failures: Map<string, string>;
  deferred: Map<string, string>;
}

async function deployMissingBuilders(snapshot: TestFleetSnapshot, options: TestFleetDeployOptions, deps: TestFleetDeployDeps, state: MutationState): Promise<void> {
  const { attempts, failures, deferred } = state;
  deferred.clear();
  for (const gateway of snapshot.gateways) {
    if (gateway.gatewayClass !== "builder" || gateway.standby || gateway.desiredStatus === "retired" || matchesPayload(gateway.latestPayload, options.payload) || attempts.has(gateway.gatewayId) || failures.has(gateway.gatewayId)) continue;
    try { attempts.set(gateway.gatewayId, await deps.deploy(gateway)); }
    catch (error) {
      if (error instanceof TestFleetDeploymentDeferredError) deferred.set(gateway.gatewayId, error.message);
      else failures.set(gateway.gatewayId, error instanceof Error ? error.message : String(error));
    }
  }
}

function snapshotProblems(snapshot: TestFleetSnapshot): string[] {
  const reasons: string[] = [];
  for (const replacement of snapshot.sharedReplacements) {
    reasons.push(`Shared replacement ${replacement.sourceGatewayId} → ${replacement.targetGatewayId} is unfinished`);
  }
  if (!snapshot.gateways.some((gateway) => gateway.gatewayClass === "shared" && gateway.desiredStatus === "running")) reasons.push("no running Shared gateway");
  return reasons;
}

function assessMissingTarget(previous: TestFleetTargetResult, snapshot: TestFleetSnapshot, timing: ObservationTiming): TestFleetTargetResult {
  if (previous.status === "shared-retired" || previous.status === "retired-skipped" || previous.status === "standby-skipped") return previous;
  const retirement = snapshot.retirements.find((proof) => proof.gatewayId === previous.gatewayId && proof.completedAt >= timing.startedAt && proof.completedAt <= timing.now);
  if (!retirement) return { ...previous, status: "failed", reasons: ["gateway disappeared before retirement was verified"] };
  if (previous.gatewayClass === "builder") return { ...previous, desiredStatus: "retired", status: "retired-skipped", reasons: [], observed: null, retirementOperationId: retirement.operationId };
  const reasons: string[] = [];
  if (!fresh(retirement.live.observedAt, timing)) reasons.push("retired Shared member removal is not freshly observed");
  if (retirement.live.instances.length) reasons.push("retired Shared member still has live instances");
  return { ...previous, desiredStatus: "retired", status: reasons.length ? "waiting" : "shared-retired",
    reasons, observed: retirement.live, retirementOperationId: retirement.operationId };
}

function assessTargets(snapshot: TestFleetSnapshot, options: TestFleetDeployOptions, timing: ObservationTiming, state: MutationState, previousTargets: TestFleetTargetResult[]): TestFleetTargetResult[] {
  const { attempts, failures, deferred } = state;
  const targets = snapshot.gateways.map((gateway) => {
    const result = targetAssessment(gateway, options, timing);
    const failure = failures.get(gateway.gatewayId);
    const wait = deferred.get(gateway.gatewayId);
    if (wait) { result.status = "waiting"; result.reasons.push(wait); }
    return { ...result, ...(attempts.has(gateway.gatewayId) ? { deployment: attempts.get(gateway.gatewayId) } : {}), ...(failure ? { status: "failed" as const, reasons: [failure] } : {}) };
  });
  for (const previous of previousTargets) {
    if (!targets.some((target) => target.gatewayId === previous.gatewayId)) targets.push(assessMissingTarget(previous, snapshot, timing));
  }
  return targets;
}

export async function deployTestFleet(options: TestFleetDeployOptions, deps: TestFleetDeployDeps): Promise<TestFleetDeployReport> {
  validateOptions(options);
  const startedAt = deps.now();
  const deadline = startedAt + options.timeoutMs;
  const mutations: MutationState = { attempts: new Map(), failures: new Map(), deferred: new Map() };
  let stableInventory: string | null = null;
  let targets: TestFleetTargetResult[] = [];
  let reasons: string[] = [];
  const report = (outcome: TestFleetDeployReport["outcome"]): TestFleetDeployReport => ({ environment: "test", sourceSha: options.sourceSha, outcome, startedAt, completedAt: deps.now(), targets, reasons });
  while (deps.now() < deadline) {
    let snapshot: TestFleetSnapshot;
    try { snapshot = await deps.readSnapshot(); }
    catch (error) {
      reasons = [`fleet snapshot failed: ${error instanceof Error ? error.message : String(error)}`];
      return report("failed");
    }
    const previousTargets = targets;
    if (!matchesTestPlatformRelease(snapshot.platform, options.payload, options.sourceSha)) {
      reasons = ["platform gateway image family is missing or superseded the requested build"];
      return report("failed");
    }
    await deployMissingBuilders(snapshot, options, deps, mutations);
    const timing = { now: deps.now(), startedAt, maxAge: options.maxObservationAgeMs ?? 180_000 };
    targets = assessTargets(snapshot, options, timing, mutations, previousTargets);
    reasons = snapshotProblems(snapshot);
    deps.log(JSON.stringify({ sourceSha: options.sourceSha, targets: targets.map((target) => ({ gatewayId: target.gatewayId, status: target.status, desiredRelease: target.desiredRelease, reasons: target.reasons, deployment: target.deployment })), reasons }));
    if (targets.some((target) => target.status === "failed")) return report("failed");
    const complete = reasons.length === 0 && targets.every((target) => target.status !== "waiting");
    const inventory = JSON.stringify(targets.map((target) => [target.gatewayId, target.desiredStatus, target.desiredRelease]).sort());
    if (complete && stableInventory === inventory) return report("converged");
    stableInventory = complete ? inventory : null;
    await deps.sleep(Math.min(options.pollIntervalMs ?? 15_000, Math.max(0, deadline - deps.now())));
  }
  return report("timed-out");
}

function tableCell(value: unknown): string {
  return String(value ?? "—").replace(/[|\r\n]/g, " ").slice(0, 128);
}

export function formatTestFleetSummary(report: TestFleetDeployReport): string {
  const targets = report.targets.slice(0, 200);
  const rows = targets.map((target) => [target.gatewayId, target.status, target.desiredRelease, target.liveRelease, (target.deployment?.operationId ?? target.retirementOperationId)].map(tableCell).join(" | "));
  return [
    `## TEST fleet: ${report.outcome}`, "", `Source: ${report.sourceSha}`, "",
    "| Gateway | Status | Desired release | Live release | Operation |", "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`), "",
    `Showing ${targets.length} of ${report.targets.length} targets. Full digest observations and failure reasons are in the job log.`,
    "Paused Builders report desired release only; their computers were not started.",
    "Standby Builders are skipped: Cowboy retires and re-mints them on the platform release.", "",
  ].join("\n");
}
