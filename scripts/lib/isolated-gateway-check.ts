import type { ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { targetAssessment, type FleetGateway, type FleetTargetResult } from "./fleet-deploy.js";

export interface IsolatedGatewayCheckOptions {
  gatewayId: string;
  sourceSha: string;
  payload: ReleasePayload;
  timeoutMs: number;
  pollIntervalMs?: number;
  maxObservationAgeMs?: number;
}

export interface IsolatedGatewayCheckDeps {
  readGateway(gatewayId: string): Promise<FleetGateway | null>;
  setDesiredStatus(gatewayId: string, desiredStatus: "running" | "paused"): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

async function waitUntilServing(options: IsolatedGatewayCheckOptions, deps: IsolatedGatewayCheckDeps, startedAt: number): Promise<FleetTargetResult> {
  const maxAge = options.maxObservationAgeMs ?? 180_000;
  let reported = "";
  for (;;) {
    const gateway = await deps.readGateway(options.gatewayId);
    if (!gateway) throw new Error(`isolated gateway ${options.gatewayId} disappeared during the check`);
    const result = targetAssessment(gateway, options, { now: deps.now(), startedAt, maxAge });
    const reasons = result.reasons.join("; ");
    if (result.status === "live") return result;
    if (result.status === "failed") throw new Error(`${options.gatewayId} failed: ${reasons}`);
    if (deps.now() - startedAt >= options.timeoutMs) throw new Error(`${options.gatewayId} did not serve ${options.sourceSha} within ${options.timeoutMs}ms: ${reasons}`);
    if (reasons !== reported) deps.log(`waiting for ${options.gatewayId}: ${reasons}`);
    reported = reasons;
    await deps.sleep(options.pollIntervalMs ?? 15_000);
  }
}

export async function checkIsolatedGateway(options: IsolatedGatewayCheckOptions, deps: IsolatedGatewayCheckDeps): Promise<FleetTargetResult> {
  const gateway = await deps.readGateway(options.gatewayId);
  if (!gateway) throw new Error(`isolated gateway ${options.gatewayId} does not exist`);
  if (gateway.gatewayClass !== "builder" || gateway.desiredStatus === "retired") throw new Error(`${options.gatewayId} is not a non-retired isolated gateway`);
  const startedAt = deps.now();
  let result: FleetTargetResult | undefined;
  let failure: unknown;
  try {
    deps.log(`resuming ${options.gatewayId} to check ${options.sourceSha}`);
    await deps.setDesiredStatus(options.gatewayId, "running");
    result = await waitUntilServing(options, deps, startedAt);
    deps.log(`${options.gatewayId} serves ${options.sourceSha} after ${deps.now() - startedAt}ms`);
  } catch (error) {
    failure = error;
  }
  try {
    await deps.setDesiredStatus(options.gatewayId, "paused");
    deps.log(`parked ${options.gatewayId}`);
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], `isolated gateway ${options.gatewayId} check failed and the gateway was not parked`);
    throw error;
  }
  if (failure) throw failure;
  return result!;
}
