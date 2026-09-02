import { spawn } from "node:child_process";

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

export function createOpenClawBootWatcher(input: {
  client: Pick<FleetBrokerClient, "claimOpenClawBoot" | "completeOpenClawBoot">;
  releaseKey: string;
  log: (message: string) => void;
  run?: RunCommand;
}): OpenClawBootWatcher {
  const run = input.run ?? runCommand;
  return {
    async beforeStart() {
      let claim: Awaited<ReturnType<FleetBrokerClient["claimOpenClawBoot"]>>;
      try {
        claim = await input.client.claimOpenClawBoot({ releaseKey: input.releaseKey });
      } catch (error) {
        if (!missingBrokerRoute(error, CLAIM_PATH)) throw error;
        input.log("[openclaw-boot] boot sentinel unavailable on this platform release; starting normally");
        return;
      }
      if (claim.action === "start") return;
      if (claim.action !== "doctor") {
        throw new Error(`invalid OpenClaw boot claim action: ${String(claim.action)}`);
      }
      input.log("[openclaw-boot] prior boot did not become healthy; running openclaw doctor --fix once");
      await run("openclaw", ["doctor", "--fix", "--non-interactive"]);
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
