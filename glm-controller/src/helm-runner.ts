import { spawn } from "node:child_process";
import type {
  GatewayProfile,
  HelmInstancesMap,
} from "../../shared/types/glm.js";
import type { SizingTier } from "../../shared/types/sizing.js";
import { SIZING_TIERS } from "../../shared/types/sizing.js";

export interface HelmRunner {

readDeployedInstances(opts: { namespace: string }): Promise<HelmInstancesMap>;

upsertInstance(opts: {
    namespace: string;
    instanceName: string;
    gatewayId: string;
    imageRepository: string;
    imageTag: string;
    serviceAccountName?: string;
    serviceAccount?: HelmInstancesMap[string]["serviceAccount"];
    gatewayContainerSecurityContext?: Record<string, unknown>;
    persistence?: HelmInstancesMap[string]["persistence"];
    operatorAccess?: HelmInstancesMap[string]["operatorAccess"];
    chartPath: string;
    valuesFile?: string;
    takeOwnership?: boolean;

chartFingerprint?: string;

profile?: GatewayProfile;

sizingTier?: SizingTier;

replicas?: number;

gcpProject?: string;
  }): Promise<void>;

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

  upgradeTimeout?: string;

  uninstallTimeout?: string;

  /**
   * Idempotent pre-install hook: ensure the per-gateway K8s auth-token
   * secret exists before `helm upgrade` runs (the chart references it via
   * secretKeyRef on init/gateway/gateway-edge — missing secret = pod boot
   * fails). Wired in production via `createAuthSecretEnsurer`. Tests that
   * don't care about this hook can leave it undefined.
   */
  ensureAuthSecret?: (opts: {
    namespace: string;
    gatewayId: string;
  }) => Promise<void>;
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
  serviceAccount?: unknown;
  gatewayContainerSecurityContext?: unknown;
  persistence?: unknown;
  operatorAccess?: unknown;
  profile?: unknown;
  sizingTier?: unknown;
  replicas?: unknown;
}

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

function readPersonalKnobs(
  v: PerReleaseValues,
): Partial<HelmInstancesMap[string]> {
  const out: Partial<HelmInstancesMap[string]> = {};
  if (typeof v.serviceAccountName === "string" && v.serviceAccountName.length > 0) {
    out.serviceAccountName = v.serviceAccountName;
  }
  if (isPlainObject(v.serviceAccount)) {
    out.serviceAccount = v.serviceAccount as unknown as HelmInstancesMap[string]["serviceAccount"];
  }
  if (isPlainObject(v.gatewayContainerSecurityContext)) {
    out.gatewayContainerSecurityContext = v.gatewayContainerSecurityContext;
  }
  if (isPlainObject(v.persistence)) {
    out.persistence = v.persistence as unknown as HelmInstancesMap[string]["persistence"];
  }
  if (isPlainObject(v.operatorAccess)) {
    out.operatorAccess = v.operatorAccess as unknown as HelmInstancesMap[string]["operatorAccess"];
  }
  if (typeof v.profile === "string" && (v.profile === "standard" || v.profile === "operator")) {
    out.profile = v.profile;
  }
  if (typeof v.sizingTier === "string" && (SIZING_TIERS as readonly string[]).includes(v.sizingTier)) {
    out.sizingTier = v.sizingTier as SizingTier;
  }
  if (typeof v.replicas === "number" && Number.isInteger(v.replicas) && v.replicas >= 0) {
    out.replicas = v.replicas;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

const HELM_SET = "--set";
const HELM_SET_STRING = "--set-string";
const HELM_SET_JSON = "--set-json";

function pushSetJson(args: string[], key: string, value: unknown): void {
  args.push(HELM_SET_JSON, `${key}=${JSON.stringify(value)}`);
}

interface BuildUpgradeArgsOpts {
  release: string;
  chartPath: string;
  namespace: string;
  instanceName: string;
  gatewayId: string;
  imageTag: string;
  imageRepository: string;
  upgradeTimeout: string;
  chartFingerprint?: string;
  profile?: string;
  sizingTier?: SizingTier;
  replicas?: number;
  serviceAccountName?: string;
  serviceAccount?: HelmInstancesMap[string]["serviceAccount"];
  gatewayContainerSecurityContext?: Record<string, unknown>;
  persistence?: HelmInstancesMap[string]["persistence"];
  operatorAccess?: HelmInstancesMap[string]["operatorAccess"];
  gcpProject?: string;
  valuesFile?: string;
  takeOwnership?: boolean;
}

/**
 * Builds the `helm upgrade --install` argv. Extracted from upsertInstance
 * so the per-knob conditionals don't push the orchestrator over the
 * complexity-15 threshold.
 *
 * Note: gcpProject is the BYO-GCP escape hatch — when set, overrides the
 * chart's gatewayEdge.env.GCP_PROJECT_ID. Otherwise the chart's
 * values.yaml + values.{prod,test}.yaml are the single source of truth
 * (no Cowboy --set, no kubectl-set-env field-manager collision risk on
 * the next upgrade — see post-mortem in PR #TBD).
 */
function buildUpgradeArgs(opts: BuildUpgradeArgsOpts): string[] {
  // String-typed fields use `--set-string` so a digit-only value (e.g.
  // imageTag="3280519" from a CI build-number tag without a SHA suffix)
  // doesn't get coerced to a number by helm's `--set` parser and rejected
  // by the chart schema. Discovered the hard way 2026-05-25 when gw-bender's
  // imageTag carried just digits and every reconcile failed with
  // "at '/imageTag': got number, want string". Numeric fields (replicas)
  // still use `--set` — they want number semantics.
  const args: string[] = [
    "upgrade",
    "--install",
    opts.release,
    opts.chartPath,
    "-n",
    opts.namespace,
    HELM_SET_STRING,
    `instanceName=${opts.instanceName}`,
    HELM_SET_STRING,
    `gatewayId=${opts.gatewayId}`,
    HELM_SET_STRING,
    `imageTag=${opts.imageTag}`,
    HELM_SET_STRING,
    `image.repository=${opts.imageRepository}`,
  ];
  if (opts.chartFingerprint) args.push(HELM_SET_STRING, `chartFingerprint=${opts.chartFingerprint}`);
  if (opts.profile) args.push(HELM_SET_STRING, `profile=${opts.profile}`);
  if (opts.sizingTier) args.push(HELM_SET_STRING, `sizingTier=${opts.sizingTier}`);
  if (opts.replicas !== undefined) args.push(HELM_SET, `replicas=${opts.replicas}`);
  if (opts.serviceAccountName) args.push(HELM_SET_STRING, `serviceAccountName=${opts.serviceAccountName}`);
  if (opts.serviceAccount) pushSetJson(args, "serviceAccount", opts.serviceAccount);
  if (opts.gatewayContainerSecurityContext) {
    pushSetJson(args, "gatewayContainerSecurityContext", opts.gatewayContainerSecurityContext);
  }
  if (opts.persistence) pushSetJson(args, "persistence", opts.persistence);
  if (opts.operatorAccess) pushSetJson(args, "operatorAccess", opts.operatorAccess);
  if (opts.gcpProject) args.push(HELM_SET_STRING, `gatewayEdge.env.GCP_PROJECT_ID=${opts.gcpProject}`);
  if (opts.valuesFile) args.push("-f", opts.valuesFile);
  if (opts.takeOwnership) args.push("--take-ownership");
  // Server-side apply + force-conflicts: matches the umbrella install path
  // that the CI deploy job has used since #913 + #1056. Cowboy was left
  // behind on strategic-merge through v3.16.4 of helm in glm-controller's
  // image, which is what caused gw-bender's helm rev 33 to fail K8s
  // schema validation on 2026-05-24 — strategic-merge collided the
  // live kubectl-set `OPENCLAW_GATEWAY_TOKEN: value=<hex>` with the new
  // chart's `OPENCLAW_GATEWAY_TOKEN: valueFrom={secretKeyRef}` into one
  // env entry with both fields. SSA + force-conflicts lets helm
  // unconditionally reclaim ownership of fields it manages from any
  // earlier kubectl-set / kubectl-patch / kubectl-rollout side-channel.
  //
  // Syntax matters: helm v4 treats --server-side as a STRING flag taking
  // "true"/"false"/"auto". Writing `--server-side --force-conflicts`
  // (no `=true`) parses as `--server-side="--force-conflicts"` — invalid
  // value silently defaulting to "auto", and the literal `--force-conflicts`
  // is never applied (#1054 post-mortem). Always `--server-side=true`.
  args.push("--server-side=true", "--force-conflicts");
  args.push("--wait", `--timeout=${opts.upgradeTimeout}`);
  return args;
}

const IN_PROGRESS_PATTERN =
  /another operation \(install\/upgrade\/rollback\) is in progress/i;

const PENDING_STATUSES = new Set([
  "pending-install",
  "pending-upgrade",
  "pending-rollback",
]);

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

const GOOD_ROLLBACK_STATUSES = new Set(["deployed", "superseded"]);

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

async function recoverStuckRelease(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
  release: string,
  upgradeTimeout: string,
  uninstallTimeout: string,
): Promise<string> {

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

    async upsertInstance(opts) {
      const { namespace, instanceName, gatewayId, imageTag, chartFingerprint, takeOwnership } =
        opts;
      const release = releaseNameForInstance(instanceName);
      const args = buildUpgradeArgs({
        ...opts,
        release,
        upgradeTimeout,
      });

      if (deps.ensureAuthSecret) {
        await deps.ensureAuthSecret({ namespace, gatewayId });
      }

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
