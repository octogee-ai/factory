import type { HelmInstancesMap } from "../../shared/types/glm";

export interface HelmRunner {
  /**
   * Render the values file representing the desired state, then
   * `helm upgrade --install` the release. Returns when helm finishes.
   * Errors propagate.
   */
  upgrade(opts: {
    release: string;
    chart: string;
    namespace: string;
    instances: HelmInstancesMap;
  }): Promise<void>;

  /**
   * Return the currently-deployed instances map by reading the helm release's
   * values. Empty map if the release doesn't exist (first-time install).
   */
  readDeployedInstances(opts: {
    release: string;
    namespace: string;
  }): Promise<HelmInstancesMap>;
}

/** Logs every call but does not actually shell out to `helm`. PR 1 default. */
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
