import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, posix } from "node:path";
import { ALL_JOBS, JOBS, UNIT_PACKAGES, type JobKey } from "./scope/manifest.js";
import { resolveScope } from "./scope/resolve.js";

export interface CheckJob {
  name: string;
  directory: string;
  nodeVersion: number;
  setup?: string[];
  installs: string[];
  commands: string[];
  matchGatewayImageNpm?: boolean;
  shard?: { index: number; total: number };
}

const emulatorDirectories: Partial<Record<JobKey, string>> = {
  [JOBS.userLifecycleEmulator]: "platform/scripts",
  [JOBS.functionsEmulator]: "functions",
  [JOBS.gatewayEdgeEmulator]: "platform/gateway-edge",
  [JOBS.glmControllerEmulator]: "platform/glm-controller",
  [JOBS.octogeeApiEmulator]: "platform/octogee-api",
};

export const NODE_MINIMUMS: Record<number, string> = { 22: "22.0.0", 24: "24.22.1" };
const DEFAULT_NODE_VERSION = 24;
const packageNodeVersion = (directory: string) => UNIT_PACKAGES.find(pkg => pkg.dir === directory)?.nodeVersion ?? DEFAULT_NODE_VERSION;

export function nodeVersionCheck(nodeVersion: number): string {
  const minimum = NODE_MINIMUMS[nodeVersion];
  if (!minimum) throw new Error(`No Node ${nodeVersion} toolchain is declared for CI`);
  return `node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); const [, wantMinor, wantPatch] = "${minimum}".split(".").map(Number); if (major !== ${nodeVersion} || (minor < wantMinor || (minor === wantMinor && patch < wantPatch))) throw new Error("CI requires Node >=${minimum} <${nodeVersion + 1} (found " + process.versions.node + "); set CI_NODE_${nodeVersion}_BIN or use ci:docker")'`;
}

export const CHECK_LANES = ["units-1", "units-2", "units-3", "emulators", "quality"] as const;
const UNIT_LANES = CHECK_LANES.filter(lane => lane.startsWith("units-"));
const unitNames: ReadonlySet<string> = new Set([...UNIT_PACKAGES.map(pkg => pkg.name), JOBS.app, JOBS.desktopPackage]);

const MEASURED_CHECK_SECONDS: Partial<Record<JobKey, number>> = {
  [JOBS.app]: 540,
  [JOBS.scripts]: 220,
  [JOBS.octogeeApi]: 140,
  [JOBS.tests]: 140,
  [JOBS.platformTests]: 120,
  [JOBS.core]: 140,
  [JOBS.gatewayEdge]: 135,
  [JOBS.desktopPackage]: 90,
  [JOBS.glmController]: 65,
  [JOBS.site]: 50,
  [JOBS.functions]: 17,
  [JOBS.desktop]: 15,
  [JOBS.obsidianConnect]: 15,
  [JOBS.shared]: 10,
};

const PRODUCT_SUFFIX = "-product";
const platformJobName = (name: string) => (name.endsWith(PRODUCT_SUFFIX) ? name.slice(0, -PRODUCT_SUFFIX.length) : name);

export function checkSeconds(name: string): number {
  return MEASURED_CHECK_SECONDS[platformJobName(name) as JobKey] ?? 5;
}

const APP_SHARDS = 2;
type ShardedJob = Pick<CheckJob, "name" | "shard">;
export const jobLabel = (job: ShardedJob): string => (job.shard ? `${job.name} ${job.shard.index}/${job.shard.total}` : job.name);
export const jobSeconds = (job: ShardedJob): number => checkSeconds(job.name) / (job.shard?.total ?? 1);

function appShards(job: CheckJob): CheckJob[] {
  return Array.from({ length: APP_SHARDS }, (_, i) => ({
    ...job, shard: { index: i + 1, total: APP_SHARDS }, commands: i === 0 ? job.commands : job.commands.filter(command => command === "npm test"),
  }));
}

function unitLaneAssignments(jobs: CheckJob[]): Map<string, string> {
  const units = jobs.filter(job => unitNames.has(platformJobName(job.name)))
    .sort((a, b) => jobSeconds(b) - jobSeconds(a) || (jobLabel(a) < jobLabel(b) ? -1 : 1));
  const loads = UNIT_LANES.map(lane => ({ lane, seconds: 0 }));
  const assignments = new Map<string, string>();
  for (const job of units) {
    const lightest = loads.reduce((min, load) => load.seconds < min.seconds ? load : min);
    lightest.seconds += jobSeconds(job);
    assignments.set(jobLabel(job), lightest.lane);
  }
  return assignments;
}

export function selectCheckLane(jobs: CheckJob[], lane = "all"): CheckJob[] {
  if (lane === "all") return jobs;
  if (!CHECK_LANES.some(value => value === lane)) throw new Error(`Unknown CI lane: ${lane}`);
  const units = unitLaneAssignments(jobs);
  return jobs.filter(job => {
    const unit = units.get(jobLabel(job));
    if (unit) return lane === unit;
    const emulator = job.name === JOBS.firestoreRules || job.name.endsWith("-emulator");
    return lane === (emulator ? "emulators" : "quality");
  });
}

export function dependencyInstaller(): (job: CheckJob, install: (directory: string) => void) => void {
  const installed = new Set<string>();
  return (job, install) => {
    for (const directory of job.installs) {
      const key = `${job.nodeVersion}:${Boolean(job.matchGatewayImageNpm)}:${directory}`;
      if (installed.has(key)) continue;
      install(directory);
      installed.add(key);
    }
  };
}

export function vitestOptions(script: string, emulated: boolean, concurrentLanes = 1, cpus = availableParallelism(), shard?: CheckJob["shard"]): string {
  if (!script.includes("vitest") || script.includes("emulators:exec")) return "";
  const sharded = shard ? ` --shard=${shard.index}/${shard.total}` : "";
  if (emulated) return ` -- --testTimeout=60000 --hookTimeout=60000 --maxWorkers=2${sharded}`;
  return ` -- --maxWorkers=${Math.max(1, Math.floor(cpus / concurrentLanes))}${sharded}`;
}

function installsFor(directory: string): string[] {
  if (directory === "tests" || directory === "platform/tests") return ["platform/scripts", "platform/shared", "platform/glm-controller", directory];
  if (directory === "platform/octogee-api") return ["platform/gateway-edge", "platform/shared", directory];
  if (["app", "artifact-worker", "functions", "platform/gateway-edge"].includes(directory)) return ["platform/shared", directory];
  if (directory === "platform/glm-controller") return ["platform/scripts", directory];
  return [directory];
}

function testJob(name: JobKey): CheckJob {
  const pkg = UNIT_PACKAGES.find(value => value.name === name);
  if (pkg) return {
    name, directory: pkg.dir, nodeVersion: packageNodeVersion(pkg.dir),
    matchGatewayImageNpm: pkg.matchGatewayImageNpm,
    installs: installsFor(pkg.dir),
    commands: [...(name === JOBS.site ? ["npx playwright install chromium"] : []), pkg.typecheck, ...(name === JOBS.core ? ["node ../scripts/ci/core-postgres.mjs"] : []), "npm test"],
  };
  const directory = emulatorDirectories[name];
  if (directory) return { name, directory, nodeVersion: packageNodeVersion(directory), installs: installsFor(directory), commands: ["npm run test:emulator"] };
  if (name === JOBS.app) return { name, directory: "app", nodeVersion: DEFAULT_NODE_VERSION, installs: installsFor("app"), commands: ["npm run typecheck", "npm test"] };
  if (name === JOBS.firestoreRules) return { name, directory: "firestore-rules-tests", nodeVersion: DEFAULT_NODE_VERSION, installs: ["firestore-rules-tests"], commands: ["npm test"] };
  if (name === JOBS.desktopPackage) return {
    name, directory: "desktop", nodeVersion: DEFAULT_NODE_VERSION, installs: ["desktop"],
    commands: ["npm run build", "CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --linux --publish never", "bash ../platform/scripts/ci/verify-linux-package.sh"],
  };
  throw new Error(`No portable CI implementation for ${name}`);
}

const LINTED_SOURCE = /\.[cm]?[jt]sx?$/;
const TOKEN_SCANNED_SOURCE = /\.(?:[cm]?[jt]sx?|astro|css|html)$/;
const FULL_LINT_INPUTS = ["eslint.config.mjs", "design-system/tailwind-preset.mjs"];
const QUALITY_HOOK = /^[^/]+\/scripts\/ci\/quality\.d\/([^/]+)\.sh$/;
const INFRASTRUCTURE_CONFIG = /(^|\/)Dockerfile[^/]*$|\.(?:tf|ya?ml)$|^(?:platform\/(?:helm|terraform|infra)|\.github)\//;
const RUST_AUDIT_INPUTS = ["artifact-worker/renderer/", "platform/scripts/ci/", "ci/"];

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function qualityCommand(name: string, files?: string[]): string {
  const command = ["bash", "platform/scripts/ci/quality.sh", name];
  if (files) command.push("--", ...files.map(shellQuote));
  return command.join(" ");
}

function qualityJobs(paths: string[], full: boolean): CheckJob[] {
  const job = (name: string, command: string): CheckJob =>
    ({ name, directory: ".", nodeVersion: DEFAULT_NODE_VERSION, installs: name === "eslint" || name === "knip" ? ["."] : [], commands: [command] });
  const jobs: CheckJob[] = [];
  const hooked = new Set(paths.map(path => QUALITY_HOOK.exec(path)?.[1]));
  const pushRepoWide = (name: string, triggered: boolean): boolean => {
    const runs = full || triggered || hooked.has(name);
    if (runs) jobs.push(job(name, qualityCommand(name)));
    return runs;
  };
  if (!pushRepoWide("eslint", paths.some(path => FULL_LINT_INPUTS.includes(path))) && paths.some(path => TOKEN_SCANNED_SOURCE.test(path))) {
    jobs.push(job("eslint", qualityCommand("eslint", paths.filter(path => LINTED_SOURCE.test(path)))));
  }
  pushRepoWide("knip", paths.includes("knip.json"));
  jobs.push(job("gitleaks", qualityCommand("gitleaks")));
  const lockfiles = paths.filter(path => path.endsWith("package-lock.json"));
  if (!pushRepoWide("osv-scanner", paths.includes("osv-scanner.toml")) && lockfiles.length) jobs.push(job("osv-scanner", qualityCommand("osv-scanner", lockfiles)));
  pushRepoWide("trivy", paths.some(path => INFRASTRUCTURE_CONFIG.test(path)));
  pushRepoWide("cargo-audit", paths.some(path => RUST_AUDIT_INPUTS.some(prefix => path.startsWith(prefix))));
  return jobs;
}

export const OVERLAY_COMMAND = "node platform/scripts/ops/overlay.mjs platform product .overlay";
export const PRODUCT_TYPECHECK_CONFIG = "tsconfig.product.json";
const PRODUCT_TYPECHECK = `npx tsc --noEmit -p ${PRODUCT_TYPECHECK_CONFIG}`;
const OVERLAY_DEPENDENCY_SYNC = "platform/scripts/ops/sync-local-file-deps.mjs";

export function overlayPackages(productRoot: string): Set<string> {
  if (!existsSync(productRoot)) return new Set();
  return new Set(readdirSync(productRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !existsSync(join(productRoot, entry.name, "package.json")))
    .map(entry => entry.name));
}

function productOverlay(job: CheckJob, products: ReadonlySet<string>, productTypecheckConfigs: ReadonlySet<string>): CheckJob[] {
  const overlaid = (directory: string) => {
    const name = directory.startsWith("platform/") ? directory.slice("platform/".length) : "";
    return products.has(name) ? `.overlay/${name}` : directory;
  };
  if (overlaid(job.directory) === job.directory) return [job];
  const directory = overlaid(job.directory);
  const installs = job.installs.map(overlaid);
  const consumers = installs.filter(install => install.startsWith(".overlay/")).map(install => `--consumer ${posix.relative(directory, install) || "."}`);
  const packLibraries = `node ${posix.relative(directory, OVERLAY_DEPENDENCY_SYNC)} ${consumers.join(" ")}`;
  const overlay = { ...job, directory, setup: [OVERLAY_COMMAND], installs, commands: [packLibraries, ...job.commands] };
  if (job.name.endsWith("-emulator")) return [overlay];
  const platformTypecheck = UNIT_PACKAGES.find(pkg => pkg.dir === job.directory)?.typecheck;
  const productTypecheck = productTypecheckConfigs.has(job.directory.slice("platform/".length));
  const commands = [packLibraries, ...(productTypecheck ? job.commands.map(command => (command === platformTypecheck ? PRODUCT_TYPECHECK : command)) : job.commands)];
  return [job, { ...overlay, name: `${job.name}${PRODUCT_SUFFIX}`, commands }];
}

export interface PlanTree {
  deleted?: ReadonlySet<string>;
  products?: ReadonlySet<string>;
  productTypecheckConfigs?: ReadonlySet<string>;
}

export function checkPlan(paths: string[], group: "tests" | "quality" | "all" = "all", desktopPackage = false, full = false, { deleted = new Set(), products = new Set(), productTypecheckConfigs = new Set() }: PlanTree = {}): CheckJob[] {
  const scope = full ? { jobs: [...ALL_JOBS], everything: true } : resolveScope(paths, deleted);
  const result = group === "quality" ? [] : scope.jobs.filter(name => desktopPackage || name !== JOBS.desktopPackage).map(testJob).flatMap(job => (job.name === JOBS.app ? appShards(job) : [job]));
  if (group !== "quality" && desktopPackage && !result.some(job => job.name === JOBS.desktopPackage)) result.push(testJob(JOBS.desktopPackage));
  const tests = result.flatMap(job => productOverlay(job, products, productTypecheckConfigs));
  if (group === "tests") return tests;
  return [...tests, ...qualityJobs(paths, scope.everything)];
}

export async function executeChecks(jobs: CheckJob[], run: (job: CheckJob) => Promise<void>): Promise<void> {
  const failures: string[] = [];
  for (const job of jobs) {
    try { await run(job); }
    catch (error) { failures.push(`${job.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(`CI failed:\n${failures.join("\n")}`);
}
