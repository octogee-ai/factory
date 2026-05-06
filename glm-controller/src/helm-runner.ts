import { spawn } from "node:child_process";
import type { HelmInstancesMap } from "../../shared/types/glm.js";

/**
 * Per-release helm interface for the gateway-pod fleet.
 *
 * Each gateway instance is its own helm release named
 * `octogee-gw-<instanceName>`, installed off the helm/octogee-gateway/
 * chart. The umbrella `octogee` release no longer owns gateway pods —
 * see helm/octogee/Chart.yaml + the Cowboy-ownership refactor.
 *
 * Cowboy is the only thing that calls these methods. CI never does.
 */
export interface HelmRunner {
  /**
   * Lists every currently-deployed gateway instance by enumerating helm
   * releases prefixed `octogee-gw-` in the namespace, then reading each
   * release's values to populate the `HelmInstancesMap`. Empty map means
   * no gateway pods are deployed yet (fresh cluster).
   */
  readDeployedInstances(opts: { namespace: string }): Promise<HelmInstancesMap>;

  /**
   * Install or upgrade ONE gateway instance's helm release. Idempotent:
   * `--install` flag means it works whether the release exists or not.
   *
   * `takeOwnership` (helm 3.16+) lets a fresh release adopt resources
   * that already exist in the cluster — used during the cutover from
   * the umbrella-managed gateway sub-chart to per-instance releases so
   * the existing Deployment + Service + PDB transfer to the new release
   * without restarting the pod.
   */
  upsertInstance(opts: {
    namespace: string;
    instanceName: string;
    gatewayId: string;
    imageRepository: string;
    imageTag: string;
    chartPath: string;
    valuesFile?: string;
    takeOwnership?: boolean;
  }): Promise<void>;

  /** Uninstall ONE gateway instance's helm release. */
  removeInstance(opts: {
    namespace: string;
    instanceName: string;
  }): Promise<void>;
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
  /** Wait timeout for upgrade/install. Defaults to "10m". */
  upgradeTimeout?: string;
  /** Wait timeout for uninstall. Defaults to "5m". */
  uninstallTimeout?: string;
}

const RELEASE_PREFIX = "octogee-gw-";

const NOT_FOUND_PATTERNS = [
  /release:\s*not found/i,
  /no release named/i,
  /no deployed releases/i,
];

function isReleaseNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

function releaseNameForInstance(instanceName: string): string {
  return `${RELEASE_PREFIX}${instanceName}`;
}

function instanceNameFromRelease(releaseName: string): string | null {
  if (!releaseName.startsWith(RELEASE_PREFIX)) return null;
  return releaseName.slice(RELEASE_PREFIX.length);
}

interface HelmListItem {
  name: string;
  namespace: string;
  status: string;
}

interface PerReleaseValues {
  gatewayId?: unknown;
  instanceName?: unknown;
  imageTag?: unknown;
  image?: { repository?: unknown; tag?: unknown };
}

/**
 * Helm `--set` parses unquoted numeric arguments as YAML numbers, so a
 * Firestore-stored `imageTag: 9778420` (a clean integer build number)
 * lands in `helm get values -o json` as `9778420` not `"9778420"`. The
 * chart still renders fine — Go templates stringify numbers — but a
 * strict `typeof === "string"` check would reject the value and skip
 * the release from the deployed map. retire-gateway's poll then sees
 * the instance "disappear" instantly and prematurely deletes the
 * glmGateways doc while the helm release lingers as an orphan.
 *
 * Coerce both string and number to string here so the parser matches
 * what helm actually rendered into the cluster.
 */
function coerceIdentityField(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function createHelmSubprocessRunner(deps: HelmSubprocessRunnerDeps): HelmRunner {
  const upgradeTimeout = deps.upgradeTimeout ?? "10m";
  const uninstallTimeout = deps.uninstallTimeout ?? "5m";

  return {
    async readDeployedInstances({ namespace }) {
      const list = await deps.runHelm([
        "list",
        "-n",
        namespace,
        "--filter",
        `^${RELEASE_PREFIX}`,
        "-o",
        "json",
      ]);
      if (list.code !== 0) {
        throw new Error(
          `helm list failed (code=${list.code}): ${list.stderr.trim() || list.stdout.trim()}`,
        );
      }
      const items = (JSON.parse(list.stdout || "[]") as HelmListItem[]) ?? [];
      const map: HelmInstancesMap = {};
      for (const item of items) {
        const instanceName = instanceNameFromRelease(item.name);
        if (!instanceName) continue;
        const valuesResult = await deps.runHelm([
          "get",
          "values",
          item.name,
          "-n",
          namespace,
          "-o",
          "json",
        ]);
        if (valuesResult.code !== 0) {
          if (isReleaseNotFound(valuesResult.stderr)) continue;
          throw new Error(
            `helm get values ${item.name} failed (code=${valuesResult.code}): ${valuesResult.stderr.trim() || valuesResult.stdout.trim()}`,
          );
        }
        const v = JSON.parse(valuesResult.stdout || "{}") as PerReleaseValues;
        const gatewayId = coerceIdentityField(v.gatewayId);
        const imageTag = coerceIdentityField(v.imageTag);
        const imageRepo = coerceIdentityField(v.image?.repository);
        if (!gatewayId || !imageTag || !imageRepo) {
          // Release exists but values are missing the identity Cowboy
          // requires — skip it from the deployed map. Fresh re-upsert
          // will overwrite cleanly.
          deps.log(
            `[helm-runner] release ${item.name} missing gatewayId/imageTag/imageRepository — skipping`,
          );
          continue;
        }
        map[instanceName] = {
          enabled: true,
          image: { repository: imageRepo, tag: imageTag },
          gatewayId,
        };
      }
      return map;
    },

    async upsertInstance({
      namespace,
      instanceName,
      gatewayId,
      imageRepository,
      imageTag,
      chartPath,
      valuesFile,
      takeOwnership,
    }) {
      const release = releaseNameForInstance(instanceName);
      const args = [
        "upgrade",
        "--install",
        release,
        chartPath,
        "-n",
        namespace,
        "--set",
        `instanceName=${instanceName}`,
        "--set",
        `gatewayId=${gatewayId}`,
        "--set",
        `imageTag=${imageTag}`,
        "--set",
        `image.repository=${imageRepository}`,
      ];
      if (valuesFile) args.push("-f", valuesFile);
      if (takeOwnership) args.push("--take-ownership");
      args.push("--wait", `--timeout=${upgradeTimeout}`);
      const result = await deps.runHelm(args);
      if (result.code !== 0) {
        throw new Error(
          `helm upgrade --install ${release} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      deps.log(
        `[helm-runner] upserted release=${release} ns=${namespace} gatewayId=${gatewayId} imageTag=${imageTag}${takeOwnership ? " (took ownership)" : ""}`,
      );
    },

    async removeInstance({ namespace, instanceName }) {
      const release = releaseNameForInstance(instanceName);
      const result = await deps.runHelm([
        "uninstall",
        release,
        "-n",
        namespace,
        "--wait",
        `--timeout=${uninstallTimeout}`,
      ]);
      if (result.code !== 0) {
        if (isReleaseNotFound(result.stderr)) {
          deps.log(
            `[helm-runner] uninstall release=${release} ns=${namespace} — already gone, no-op`,
          );
          return;
        }
        throw new Error(
          `helm uninstall ${release} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      deps.log(
        `[helm-runner] uninstalled release=${release} ns=${namespace}`,
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
    readDeployedInstances: async ({ namespace }) => {
      log(`[helm-runner:stub] readDeployedInstances ns=${namespace} — returning empty`);
      return {};
    },
    upsertInstance: async (opts) => {
      log(
        `[helm-runner:stub] upsertInstance ns=${opts.namespace} instanceName=${opts.instanceName} gatewayId=${opts.gatewayId} imageTag=${opts.imageTag} — no exec`,
      );
    },
    removeInstance: async (opts) => {
      log(
        `[helm-runner:stub] removeInstance ns=${opts.namespace} instanceName=${opts.instanceName} — no exec`,
      );
    },
  };
}
