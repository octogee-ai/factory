import { spawn } from "node:child_process";
import type { HelmInstancesMap } from "../../shared/types/glm.js";

export interface HelmRunner {
  upgrade(opts: {
    release: string;
    chart: string;
    namespace: string;
    instances: HelmInstancesMap;
  }): Promise<void>;

  /**
   * Return the currently-deployed instances map by reading the helm release's
   * values. Empty map if the release doesn't exist (first-time install) or
   * if no gateway.instances are configured yet.
   */
  readDeployedInstances(opts: {
    release: string;
    namespace: string;
  }): Promise<HelmInstancesMap>;
}

export interface HelmSubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type HelmSubprocess = (args: string[]) => Promise<HelmSubprocessResult>;

export interface HelmSubprocessRunnerDeps {
  runHelm: HelmSubprocess;
  log: (msg: string) => void;
  /** Wait timeout for upgrade. Defaults to "10m". */
  upgradeTimeout?: string;
}

const NOT_FOUND_PATTERNS = [
  /release:\s*not found/i,
  /no release named/i,
];

function isReleaseNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

export function createHelmSubprocessRunner(deps: HelmSubprocessRunnerDeps): HelmRunner {
  const timeout = deps.upgradeTimeout ?? "10m";

  return {
    async readDeployedInstances({ release, namespace }) {
      const result = await deps.runHelm([
        "get",
        "values",
        release,
        "-n",
        namespace,
        "-o",
        "json",
      ]);
      if (result.code !== 0) {
        if (isReleaseNotFound(result.stderr)) return {};
        throw new Error(
          `helm get values failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      const parsed = JSON.parse(result.stdout || "{}") as {
        gateway?: { instances?: HelmInstancesMap };
      };
      return parsed.gateway?.instances ?? {};
    },

    async upgrade({ release, chart, namespace, instances }) {
      const args = [
        "upgrade",
        "--install",
        release,
        chart,
        "-n",
        namespace,
        "--reuse-values",
        "--set-json",
        `gateway.instances=${JSON.stringify(instances)}`,
        "--wait",
        `--timeout=${timeout}`,
      ];
      const result = await deps.runHelm(args);
      if (result.code !== 0) {
        throw new Error(
          `helm upgrade failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      const names = Object.keys(instances).sort();
      deps.log(
        `[helm-runner] upgrade ok release=${release} ns=${namespace} instances=[${names.join(", ")}]`,
      );
    },
  };
}

const DEFAULT_HELM_BIN = "/usr/local/bin/helm";

export function spawnHelm(args: string[]): Promise<HelmSubprocessResult> {
  const helmBin = process.env.HELM_BIN ?? DEFAULT_HELM_BIN;
  return new Promise<HelmSubprocessResult>((resolve, reject) => {
    const proc = spawn(helmBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (signal !== null) {
        resolve({
          stdout,
          stderr: stderr + `\nhelm terminated by signal ${signal}`,
          code: 128,
        });
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** Logs every call but does not actually shell out to `helm`. */
export function createLoggingHelmRunner(log: (msg: string) => void): HelmRunner {
  return {
    upgrade: async ({ release, chart, namespace, instances }) => {
      const names = Object.keys(instances).sort();
      log(
        `[helm-runner:stub] upgrade release=${release} chart=${chart} ns=${namespace} instances=[${names.join(", ")}] — no exec`,
      );
    },
    readDeployedInstances: async ({ release, namespace }) => {
      log(
        `[helm-runner:stub] readDeployedInstances release=${release} ns=${namespace} — returning empty (PR 1 stub)`,
      );
      return {};
    },
  };
}
