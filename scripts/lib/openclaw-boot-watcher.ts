import { spawn } from "node:child_process";

import type { FleetBrokerClient } from "./fleet-broker-client.js";

export interface OpenClawBootWatcher {
  beforeStart(): Promise<void>;
  healthy(): Promise<void>;
}

type RunCommand = (command: string, args: readonly string[]) => Promise<void>;

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} ${args.join(" ")} failed ${signal ? `with ${signal}` : `with exit ${code}`}`,
      ));
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
      const claim = await input.client.claimOpenClawBoot({ releaseKey: input.releaseKey });
      if (claim.action === "start") return;
      if (claim.action !== "doctor") {
        throw new Error(`invalid OpenClaw boot claim action: ${String(claim.action)}`);
      }
      input.log("[openclaw-boot] prior boot did not become healthy; running openclaw doctor --fix once");
      await run("openclaw", ["doctor", "--fix"]);
    },
    healthy() {
      return input.client.completeOpenClawBoot({ releaseKey: input.releaseKey });
    },
  };
}
