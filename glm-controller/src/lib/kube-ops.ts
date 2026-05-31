export interface KubeOps {
  scaleDeployment(opts: {
    namespace: string;
    name: string;
    replicas: number;
  }): Promise<void>;
  restartOpenClawInPlace(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  readDeployedReplicas(opts: {
    namespace: string;
    name: string;
  }): Promise<number | null>;
  readAvailableReplicas(opts: {
    namespace: string;
    name: string;
  }): Promise<number | null>;
  deletePersistentVolumeClaim(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
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

    async restartOpenClawInPlace({ namespace, name }) {
      // In-process OpenClaw restart via the gateway's own RPC — NOT a pod
      // reroll. `openclaw gateway restart --safe` asks the running gateway to
      // restart itself (self-authorizing over the local RPC); in a container
      // (no systemd/launchd) OpenClaw does an in-process restart, so the pod
      // stays up and restartCount is unchanged. `--skip-deferral` bypasses the
      // active-work idle-drain wait so an operator click restarts promptly.
      // `-c gateway` targets the container that holds the openclaw CLI +
      // process (not gateway-edge). Requires the gateway to be reachable —
      // an unreachable/crash-looping pod needs a true reroll, which the
      // operator drives separately.
      const args = [
        "-n",
        namespace,
        "exec",
        `deploy/${name}`,
        "-c",
        "gateway",
        "--",
        "openclaw",
        "gateway",
        "restart",
        "--safe",
        "--skip-deferral",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        throw new Error(
          `openclaw gateway restart (in-place) deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(
        `[kube-ops] in-process OpenClaw restart deploy/${name} ns=${namespace}`,
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

    async readAvailableReplicas({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "get",
        `deploy/${name}`,
        "-o",
        "jsonpath={.status.availableReplicas}",
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
      if (raw === "") return 0;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace}: unparseable availableReplicas '${raw}'`,
        );
      }
      return n;
    },

    async deletePersistentVolumeClaim({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "delete",
        `pvc/${name}`,
        "--ignore-not-found=true",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        throw new Error(
          `kubectl delete pvc/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(`[kube-ops] deleted pvc/${name} ns=${namespace}`);
    },
  };
}

export function createLoggingKubeOps(log: (msg: string) => void): KubeOps {
  return {
    scaleDeployment: async ({ namespace, name, replicas }) => {
      log(`[kube-ops:stub] scale ns=${namespace} ${name} → ${replicas} — no exec`);
    },
    restartOpenClawInPlace: async ({ namespace, name }) => {
      log(`[kube-ops:stub] in-process OpenClaw restart ns=${namespace} ${name} — no exec`);
    },
    readDeployedReplicas: async ({ namespace, name }) => {
      log(`[kube-ops:stub] readReplicas ns=${namespace} ${name} — returning null`);
      return null;
    },
    readAvailableReplicas: async ({ namespace, name }) => {
      log(`[kube-ops:stub] readAvailableReplicas ns=${namespace} ${name} — returning null`);
      return null;
    },
    deletePersistentVolumeClaim: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete pvc ns=${namespace} ${name} — no exec`);
    },
  };
}
