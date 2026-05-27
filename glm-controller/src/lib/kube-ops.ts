export interface KubeOps {
  scaleDeployment(opts: {
    namespace: string;
    name: string;
    replicas: number;
  }): Promise<void>;
  restartDeployment(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  readDeployedReplicas(opts: {
    namespace: string;
    name: string;
  }): Promise<number | null>;
}

export interface KubectlSubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type KubectlSubprocess = (args: string[]) => Promise<KubectlSubprocessResult>;

export interface KubeOpsRunnerDeps {
  runKubectl: KubectlSubprocess;
  log: (msg: string) => void;
}

const NOT_FOUND_PATTERN = /\(NotFound\)/;

function isNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERN.test(stderr);
}

export function createKubeSubprocessRunner(deps: KubeOpsRunnerDeps): KubeOps {
  return {
    async scaleDeployment({ namespace, name, replicas }) {
      if (!Number.isInteger(replicas) || replicas < 0) {
        throw new Error(
          `scaleDeployment: replicas must be a non-negative integer (got ${replicas})`,
        );
      }
      const args = [
        "-n",
        namespace,
        "scale",
        `deploy/${name}`,
        `--replicas=${replicas}`,
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) {
          deps.log(
            `[kube-ops] scale deploy/${name} ns=${namespace} — deployment not found, no-op (idempotent)`,
          );
          return;
        }
        throw new Error(
          `kubectl scale deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(
        `[kube-ops] scaled deploy/${name} ns=${namespace} → replicas=${replicas}`,
      );
    },

    async restartDeployment({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "rollout",
        "restart",
        `deploy/${name}`,
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        throw new Error(
          `kubectl rollout restart deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(
        `[kube-ops] rollout restart deploy/${name} ns=${namespace}`,
      );
    },

    async readDeployedReplicas({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "get",
        `deploy/${name}`,
        "-o",
        "jsonpath={.spec.replicas}",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) return null;
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      const raw = result.stdout.trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace}: unparseable replicas '${raw}'`,
        );
      }
      return n;
    },
  };
}

export function createLoggingKubeOps(log: (msg: string) => void): KubeOps {
  return {
    scaleDeployment: async ({ namespace, name, replicas }) => {
      log(`[kube-ops:stub] scale ns=${namespace} ${name} → ${replicas} — no exec`);
    },
    restartDeployment: async ({ namespace, name }) => {
      log(`[kube-ops:stub] restart ns=${namespace} ${name} — no exec`);
    },
    readDeployedReplicas: async ({ namespace, name }) => {
      log(`[kube-ops:stub] readReplicas ns=${namespace} ${name} — returning null`);
      return null;
    },
  };
}
