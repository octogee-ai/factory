import { spawn } from "node:child_process";
import type { AgentSchemaFit } from "./agent-store-preflight.js";

import { repairSourceDoctorAgentStores, verifySourceDoctorAgentStores } from "./openclaw-source-doctor.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";

export interface OpenClawBootWatcher {
  beforeStart(): Promise<void>;
  healthy(): Promise<void>;
}

type RunCommand = (command: string, args: readonly string[]) => Promise<void>;

const CLAIM_PATH = "/internal/fleet/openclaw-boot/claim";
const HEALTHY_PATH = "/internal/fleet/openclaw-boot/healthy";

function missingBrokerRoute(error: unknown, path: string): boolean {
  return error instanceof Error
    && error.message.includes(`fleet-broker POST ${path} → 404`);
}

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const outcome = signal ? `with ${signal}` : `with exit ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed ${outcome}`));
    });
  });
}

function sourceDoctorRequest(claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>) {
  const request = claim.sourceDoctor;
  if (request && (typeof request.requestId !== "string" || !request.requestId || request.requestId.includes("/") || !Array.isArray(request.agentIds) ||
      request.agentIds.length === 0 || new Set(request.agentIds).size !== request.agentIds.length ||
      !request.agentIds.every((id) => /^octogee-[a-z0-9][a-z0-9_-]*-coach$/.test(id)) ||
      request.schedulerStateRecovery !== undefined && (request.schedulerStateRecovery !== true || !request.postgresAgentStores))) throw new Error("invalid source Doctor request");
  return request;
}

export function createOpenClawBootWatcher(input: {
  client: Pick<FleetBrokerClient, "claimOpenClawBoot" | "completeOpenClawBoot" | "completeOpenClawDoctor"> & Partial<Pick<FleetBrokerClient, "assertOpenClawDoctor">>;
  releaseKey: string;
  log: (message: string) => void;
  run?: RunCommand;
  verifySourceDoctor?: (agentIds: string[]) => Promise<void>;
  repairSourceDoctor?: typeof repairSourceDoctorAgentStores;
  inspectBuilderStores?: () => Promise<AgentSchemaFit>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): OpenClawBootWatcher {
  const run = input.run ?? runCommand;
  const now = input.now ?? (() => performance.now());
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  async function claimBoot(): Promise<Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>> {
    const deadline = now() + 120_000;
    let pendingRequest: string | undefined;
    for (;;) {
      let claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>;
      try { claim = await input.client.claimOpenClawBoot({ releaseKey: input.releaseKey }); }
      catch (error) {
        if (pendingRequest) throw new Error("source Doctor claim failed while awaiting installed image proof", { cause: error });
        throw error;
      }
      const request = sourceDoctorRequest(claim);
      if (pendingRequest && pendingRequest !== request?.requestId) throw new Error("source Doctor request changed while waiting for installed image proof");
      if (claim.action !== "wait") return claim;
      if (!request) throw new Error("source Doctor image wait requires an explicit request");
      pendingRequest = request.requestId;
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("source Doctor installed image proof wait timed out");
      input.log("[openclaw-boot] awaiting controller verification of the installed source recovery image");
      await wait(Math.min(2_000, remaining));
    }
  }
  return {
    async beforeStart() {
      let claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>;
      try {
        claim = await claimBoot();
      } catch (error) {
        if (!missingBrokerRoute(error, CLAIM_PATH)) throw error;
        input.log("[openclaw-boot] boot sentinel unavailable on this platform release; starting normally");
        claim = { action: "start" };
      }
      if (claim.action !== "start" && claim.action !== "doctor") {
        throw new Error(`invalid OpenClaw boot claim action: ${String(claim.action)}`);
      }
      const fit = await input.inspectBuilderStores?.();
      if (claim.action === "start" && fit !== "repair-required") return;
      if (fit === "repair-required") input.log("[openclaw-boot] configured Builder stores require canonical Doctor before startup");
      else if (claim.sourceDoctor) input.log("[openclaw-boot] running explicitly requested source Doctor before gateway startup");
      else input.log("[openclaw-boot] prior boot did not become healthy; running openclaw doctor --fix once");
      await runClaimedDoctor(input, claim, run);
      if (input.inspectBuilderStores && await input.inspectBuilderStores() !== "exact") {
        throw new Error("configured Builder stores remain incompatible after canonical Doctor");
      }
      if (claim.sourceDoctor) {
        if (!claim.sourceDoctor.postgresAgentStores) await (input.verifySourceDoctor ?? verifySourceDoctorAgentStores)(claim.sourceDoctor.agentIds);
        await input.client.completeOpenClawDoctor({ releaseKey: input.releaseKey, requestId: claim.sourceDoctor.requestId,
          verifiedAgentIds: claim.sourceDoctor.agentIds });
      }
    },
    async healthy() {
      try {
        await input.client.completeOpenClawBoot({ releaseKey: input.releaseKey });
      } catch (error) {
        if (!missingBrokerRoute(error, HEALTHY_PATH)) throw error;
        input.log("[openclaw-boot] boot sentinel completion unavailable on this platform release");
      }
    },
  };
}

async function runClaimedDoctor(input: Parameters<typeof createOpenClawBootWatcher>[0],
  claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>, run: RunCommand): Promise<void> {
  if (!claim.sourceDoctor?.postgresAgentStores) {
    await run("openclaw", ["doctor", "--fix", "--non-interactive"]);
    return;
  }
  const request = claim.sourceDoctor, assertDoctor = input.client.assertOpenClawDoctor;
  if (!assertDoctor) throw new Error("PostgreSQL source Doctor authority checks are unavailable");
  await (input.repairSourceDoctor ?? repairSourceDoctorAgentStores)(request.agentIds, {
    diagnostics: { requestId: request.requestId, releaseKey: input.releaseKey, log: input.log },
    expectedAnchors: request.postgresAgentStores,
    ...(request.schedulerStateRecovery ? { schedulerStateRecovery: true } : {}),
    assertCurrent: () => assertDoctor({ releaseKey: input.releaseKey, requestId: request.requestId }),
  });
}
