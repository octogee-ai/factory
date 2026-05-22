import { spawn } from "node:child_process";
import type {
  GatewayProfile,
  HelmInstancesMap,
} from "../../shared/types/glm.js";
import { resolveGatewayGcpProject } from "./gcp-project.js";

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
    serviceAccountName?: string;
    gatewayContainerSecurityContext?: Record<string, unknown>;
    persistence?: HelmInstancesMap[string]["persistence"];
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
    /**
     * Capability profile — passed as a `--set profile=...` helm value when
     * present so chart templates can render profile-conditional resources
     * (e.g. operator gateways skip platform `ANTHROPIC_API_KEY` env
     * injection — operators auth via per-agent BYOS / `claude auth login`).
     * Cattle leaves this absent; chart default `profile: ""` preserves the
     * existing welcome-path env injection.
     */
    profile?: GatewayProfile;
    /**
     * GCP project for the gateway-edge sidecar (gateway-token resolution,
     * Secret Manager, KMS). Threaded as `--set gatewayEdge.env.GCP_PROJECT_ID`
     * so the value is always present from the live desired-state — immune to
     * the baked values-file skew that silently dropped it post-#1131. Absent
     * ⇒ the platform default. BYO-GCP seam: per-Builder project flows here.
     */
    gcpProject?: string;
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
  serviceAccountName?: unknown;
  gatewayContainerSecurityContext?: unknown;
  persistence?: unknown;
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
    ...readPersonalKnobs(v),
  };
}

// Per-instance pet knobs as round-tripped by `helm get values`. Split
// out of readInstanceValue so that function stays under the complexity
// ratchet; each knob is optional and absent unless the live release
// actually carries it.
function readPersonalKnobs(
  v: PerReleaseValues,
): Partial<HelmInstancesMap[string]> {
  const out: Partial<HelmInstancesMap[string]> = {};
  if (typeof v.serviceAccountName === "string" && v.serviceAccountName.length > 0) {
    out.serviceAccountName = v.serviceAccountName;
  }
  if (isPlainObject(v.gatewayContainerSecurityContext)) {
    out.gatewayContainerSecurityContext = v.gatewayContainerSecurityContext;
  }
  if (isPlainObject(v.persistence)) {
    out.persistence = v.persistence as unknown as HelmInstancesMap[string]["persistence"];
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function pushSetJson(args: string[], key: string, value: unknown): void {
  args.push("--set-json", `${key}=${JSON.stringify(value)}`);
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

// Release states that need recovery before a fresh `helm upgrade` is
// safe to attempt. The post-flight `IN_PROGRESS_PATTERN` check only
// triggers when helm itself reports the conflict — but a prior `helm
// upgrade --wait` that timed out (pods OOM / ImagePullBackOff / slow
// readiness) errors with "context deadline exceeded" without matching
// IN_PROGRESS, leaving the release stuck in pending-*. Next reconcile
// → same timeout → wedge forever. Pre-flight `helm status` catches
// this and runs recoverStuckRelease before the upgrade attempt.
// (gw-bender wedge 2026-05-20: OC 2026.5.19 OOM → 3-min timeout →
// pending-upgrade → 4 more reconcile ticks each hit the same timeout
// before manual `helm rollback` unwedged it.)
const PENDING_STATUSES = new Set([
  "pending-install",
  "pending-upgrade",
  "pending-rollback",
]);

/**
 * Read the current helm release status. Returns null for a release
 * that doesn't exist (fresh-install path). Throws on any other error
 * — a control-plane outage during the status check must not be
 * silently swallowed (the recovery decision depends on it).
 */
async function getReleaseStatus(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
  release: string,
): Promise<string | null> {
  const result = await deps.runHelm([
    "status", release, "-n", namespace, "-o", "json",
  ]);
  if (result.code !== 0) {
    if (isReleaseNotFound(result.stderr)) return null;
    throw new Error(
      `helm status ${release} (ns=${namespace}) failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let parsed: { info?: { status?: unknown } };
  try {
    parsed = JSON.parse(result.stdout) as { info?: { status?: unknown } };
  } catch (e) {
    throw new Error(
      `helm status ${release} (ns=${namespace}): could not parse JSON output: ${(e as Error).message}`,
    );
  }
  // Fail closed when `info.status` is absent/non-string: a changed
  // `helm status -o json` shape silently returning null here would be
  // treated as "release not found" and skip recovery → the wedge we're
  // trying to escape. Surface the unexpected shape so the operator
  // sees it instead.
  const status = parsed.info?.status;
  if (typeof status !== "string" || status.length === 0) {
    const sample = result.stdout.slice(0, 200);
    throw new Error(
      `helm status ${release} (ns=${namespace}): info.status missing or non-string in response (got ${typeof status}). stdout[:200]: ${sample}`,
    );
  }
  return status;
}

interface HelmHistoryItem {
  revision: number;
  status: string;
}

// Only revisions that actually applied their manifests are safe rollback
// targets. `failed` is excluded (it may have left a partial release);
// `pending-*` is the wedge we're escaping.
const GOOD_ROLLBACK_STATUSES = new Set(["deployed", "superseded"]);

// We only reach recovery because helm itself reported this release stuck
// in `pending-*` — so it exists and *must* have revision history. Every
// "helm gave us something we can't reason about" shape (non-JSON banner,
// valid JSON that isn't an array, an array with no recognizable
// {revision,status} items, or empty) is treated as a hard recovery error:
// throw so the bounded reconcile retry handles it, rather than letting
// `findLastGoodRevision` return null and silently routing to the
// destructive uninstall path (which would delete a possibly-healthy
// release). The only non-throwing path is a well-formed, non-empty
// history — exactly what a genuine wedged release always has.
function parseHelmHistory(release: string, stdout: string): HelmHistoryItem[] {
  const raw = stdout.trim() || "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `helm history ${release} returned unparseable output during recovery: ${raw.slice(0, 200)}`,
    );
  }
  const items = Array.isArray(parsed)
    ? parsed.filter(
        (h): h is HelmHistoryItem =>
          typeof (h as { revision?: unknown } | null)?.revision === "number" &&
          typeof (h as { status?: unknown } | null)?.status === "string",
      )
    : [];
  if (items.length === 0) {
    throw new Error(
      `helm history ${release} returned no usable revision history during recovery: ${raw.slice(0, 200)}`,
    );
  }
  return items;
}

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
  // No `--max`: a low cap could truncate away the only good revision on
  // a release that churned through many failed/pending revisions since
  // its last deploy, making findLastGoodRevision return null and pushing
  // recovery down the destructive uninstall path. Helm's own default cap
  // (256) is plenty for the slow-moving gateway fleet.
  const hist = await deps.runHelm([
    "history", release, "-n", namespace, "-o", "json",
  ]);
  if (hist.code !== 0) {
    if (isReleaseNotFound(hist.stderr)) {
      return `${release} no longer exists — retry will fresh-install`;
    }
    throw new Error(
      `helm history ${release} failed during recovery (code=${hist.code}): ${hist.stderr.trim() || hist.stdout.trim()}`,
    );
  }
  const history = parseHelmHistory(release, hist.stdout);
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
      serviceAccountName,
      gatewayContainerSecurityContext,
      persistence,
      profile,
      gcpProject,
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
      if (profile) {
        args.push("--set", `profile=${profile}`);
      }
      if (serviceAccountName) {
        args.push("--set", `serviceAccountName=${serviceAccountName}`);
      }
      if (gatewayContainerSecurityContext) {
        pushSetJson(args, "gatewayContainerSecurityContext", gatewayContainerSecurityContext);
      }
      if (persistence) {
        pushSetJson(args, "persistence", persistence);
      }
      // Always thread GCP_PROJECT_ID from the live render (BYO-GCP-ready)
      // so it's present regardless of baked values-file skew — the
      // silent-drop root post-#1131. `--set` overrides the chart's
      // gatewayEdge.env default without a duplicate (set wins over -f).
      // Platform default = Cowboy's own project env. `GOOGLE_CLOUD_PROJECT`
      // is what the chart actually sets (the others are unset in PROD), so
      // read it first. No hard-coded project fallback: an unset env in a
      // non-prod namespace must NOT silently pin gateways to the prod
      // project — resolveGatewayGcpProject throws on empty (fail loud).
      const platformGcpProject =
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        process.env.GCP_PROJECT_ID ||
        "";
      args.push(
        "--set",
        `gatewayEdge.env.GCP_PROJECT_ID=${resolveGatewayGcpProject({ gcpProject, platformDefault: platformGcpProject })}`,
      );
      if (valuesFile) args.push("-f", valuesFile);
      if (takeOwnership) args.push("--take-ownership");
      args.push("--wait", `--timeout=${upgradeTimeout}`);

      // Pre-flight: detect a release left in pending-* by a prior
      // --wait timeout (pods OOM / ImagePullBackOff / slow readiness)
      // and roll back BEFORE the new upgrade attempt. Without this,
      // the wedge persists across reconcile ticks because the timeout
      // error class doesn't match the post-flight IN_PROGRESS pattern.
      const preFlightStatus = await getReleaseStatus(deps, namespace, release);
      if (preFlightStatus !== null && PENDING_STATUSES.has(preFlightStatus)) {
        deps.log(
          `[helm-runner] ⚠ ${release} pre-flight detected stuck state '${preFlightStatus}' — running recovery before upgrade`,
        );
        const recovered = await recoverStuckRelease(
          deps,
          namespace,
          release,
          upgradeTimeout,
          uninstallTimeout,
        );
        deps.log(`[helm-runner] pre-flight recovery: ${recovered}`);
      }

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
      const uninstallArgs = [
        "uninstall",
        release,
        "-n",
        namespace,
        "--wait",
        `--timeout=${uninstallTimeout}`,
      ];
      let result = await deps.runHelm(uninstallArgs);
      // A release wedged in `pending-*` rejects `helm uninstall` with the
      // same in-progress error as upgrade — a gateway that wedged and is
      // then retired would otherwise fail uninstall forever, leaving an
      // orphan helm release. Same recovery as upsert: clear the pending
      // state, then retry the uninstall once.
      if (
        result.code !== 0 &&
        !isReleaseNotFound(result.stderr) &&
        IN_PROGRESS_PATTERN.test(`${result.stderr}\n${result.stdout}`)
      ) {
        deps.log(
          `[helm-runner] ⚠ ${release} stuck (another helm operation in progress) — attempting recovery before uninstall`,
        );
        const recovered = await recoverStuckRelease(
          deps,
          namespace,
          release,
          upgradeTimeout,
          uninstallTimeout,
        );
        deps.log(`[helm-runner] recovery: ${recovered} — retrying uninstall`);
        result = await deps.runHelm(uninstallArgs);
      }
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
