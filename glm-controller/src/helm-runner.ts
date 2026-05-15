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
    /**
     * Fingerprint of the chart bytes being applied. Passed as a helm
     * `--set` value so subsequent reconciles can compare desired vs
     * deployed and detect chart-template drift even when image-tag is
     * unchanged.
     */
    chartFingerprint?: string;
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
  chartFingerprint?: unknown;
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

async function listGatewayReleases(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
): Promise<HelmListItem[]> {
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
  return (JSON.parse(list.stdout || "[]") as HelmListItem[]) ?? [];
}

async function readInstanceValue(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
  releaseName: string,
): Promise<HelmInstancesMap[string] | null> {
  const valuesResult = await deps.runHelm([
    "get",
    "values",
    releaseName,
    "-n",
    namespace,
    "-o",
    "json",
  ]);
  if (valuesResult.code !== 0) {
    if (isReleaseNotFound(valuesResult.stderr)) return null;
    throw new Error(
      `helm get values ${releaseName} failed (code=${valuesResult.code}): ${valuesResult.stderr.trim() || valuesResult.stdout.trim()}`,
    );
  }
  const v = JSON.parse(valuesResult.stdout || "{}") as PerReleaseValues;
  const gatewayId = coerceIdentityField(v.gatewayId);
  const imageTag = coerceIdentityField(v.imageTag);
  const imageRepo = coerceIdentityField(v.image?.repository);
  if (!gatewayId || !imageTag || !imageRepo) {
    deps.log(
      `[helm-runner] release ${releaseName} missing gatewayId/imageTag/imageRepository — skipping`,
    );
    return null;
  }
  const chartFingerprint =
    typeof v.chartFingerprint === "string" && v.chartFingerprint.length > 0
      ? v.chartFingerprint
      : undefined;
  return {
    enabled: true,
    image: { repository: imageRepo, tag: imageTag },
    gatewayId,
    ...(chartFingerprint ? { chartFingerprint } : {}),
  };
}

// Helm refuses any new operation on a release whose previous
// install/upgrade/rollback was interrupted (process killed mid-flight),
// leaving it pinned in `pending-*`. Cowboy is itself redeployed on every
// platform release, so being SIGTERM'd mid-`helm upgrade` is routine —
// without recovery the reconcile loop retries this forever and the
// gateway never advances. Helm 3.x emits this exact phrasing for all
// three pending states.
const IN_PROGRESS_PATTERN =
  /another operation \(install\/upgrade\/rollback\) is in progress/i;

interface HelmHistoryItem {
  revision: number;
  status: string;
}

// Only revisions that actually applied their manifests are safe rollback
// targets. `failed` is excluded (it may have left a partial release);
// `pending-*` is the wedge we're escaping.
const GOOD_ROLLBACK_STATUSES = new Set(["deployed", "superseded"]);

function findLastGoodRevision(history: readonly HelmHistoryItem[]): number | null {
  let best: number | null = null;
  for (const h of history) {
    if (
      typeof h.revision === "number" &&
      GOOD_ROLLBACK_STATUSES.has(h.status) &&
      (best === null || h.revision > best)
    ) {
      best = h.revision;
    }
  }
  return best;
}

/**
 * Clear a release stuck in `pending-*`. Roll back to the last revision
 * that actually applied; if none ever did (a wedged first install),
 * uninstall so the caller's retried `upgrade --install` fresh-installs.
 * Returns a human-readable description of the action for logging.
 * Throws if the recovery operation itself fails — the caller must NOT
 * retry the upgrade against a still-stuck release.
 */
async function recoverStuckRelease(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
  release: string,
  upgradeTimeout: string,
  uninstallTimeout: string,
): Promise<string> {
  const hist = await deps.runHelm([
    "history", release, "-n", namespace, "-o", "json", "--max", "20",
  ]);
  if (hist.code !== 0) {
    if (isReleaseNotFound(hist.stderr)) {
      return `${release} no longer exists — retry will fresh-install`;
    }
    throw new Error(
      `helm history ${release} failed during recovery (code=${hist.code}): ${hist.stderr.trim() || hist.stdout.trim()}`,
    );
  }
  const history = JSON.parse(hist.stdout || "[]") as HelmHistoryItem[];
  const target = findLastGoodRevision(history);
  if (target === null) {
    const un = await deps.runHelm([
      "uninstall", release, "-n", namespace, "--wait", `--timeout=${uninstallTimeout}`,
    ]);
    if (un.code !== 0 && !isReleaseNotFound(un.stderr)) {
      throw new Error(
        `helm uninstall ${release} failed during recovery (code=${un.code}): ${un.stderr.trim() || un.stdout.trim()}`,
      );
    }
    return `uninstalled stuck first-install ${release} (no good revision to roll back to)`;
  }
  const rb = await deps.runHelm([
    "rollback", release, String(target), "-n", namespace, "--wait", `--timeout=${upgradeTimeout}`,
  ]);
  if (rb.code !== 0) {
    throw new Error(
      `helm rollback ${release} → revision ${target} failed during recovery (code=${rb.code}): ${rb.stderr.trim() || rb.stdout.trim()}`,
    );
  }
  return `rolled back ${release} to revision ${target}`;
}

export function createHelmSubprocessRunner(deps: HelmSubprocessRunnerDeps): HelmRunner {
  const upgradeTimeout = deps.upgradeTimeout ?? "10m";
  const uninstallTimeout = deps.uninstallTimeout ?? "5m";

  return {
    async readDeployedInstances({ namespace }) {
      const items = await listGatewayReleases(deps, namespace);
      const entries: [string, HelmInstancesMap[string]][] = [];
      for (const item of items) {
        const instanceName = instanceNameFromRelease(item.name);
        if (!instanceName) continue;
        const value = await readInstanceValue(deps, namespace, item.name);
        if (value) entries.push([instanceName, value]);
      }
      return Object.fromEntries(entries);
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
      chartFingerprint,
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
      if (chartFingerprint) {
        args.push("--set", `chartFingerprint=${chartFingerprint}`);
      }
      if (valuesFile) args.push("-f", valuesFile);
      if (takeOwnership) args.push("--take-ownership");
      args.push("--wait", `--timeout=${upgradeTimeout}`);
      let result = await deps.runHelm(args);
      if (
        result.code !== 0 &&
        IN_PROGRESS_PATTERN.test(`${result.stderr}\n${result.stdout}`)
      ) {
        deps.log(
          `[helm-runner] ⚠ ${release} stuck (another helm operation in progress) — attempting recovery`,
        );
        const recovered = await recoverStuckRelease(
          deps,
          namespace,
          release,
          upgradeTimeout,
          uninstallTimeout,
        );
        deps.log(`[helm-runner] recovery: ${recovered} — retrying upgrade`);
        result = await deps.runHelm(args);
      }
      if (result.code !== 0) {
        throw new Error(
          `helm upgrade --install ${release} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      const fpTag = chartFingerprint ? ` chartFingerprint=${chartFingerprint.slice(0, 12)}` : "";
      const ownershipTag = takeOwnership ? " (took ownership)" : "";
      deps.log(
        `[helm-runner] upserted release=${release} ns=${namespace} gatewayId=${gatewayId} imageTag=${imageTag}${fpTag}${ownershipTag}`,
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
