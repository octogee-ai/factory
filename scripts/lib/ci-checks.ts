import { availableParallelism } from "node:os";
import { ALL_JOBS, JOBS, UNIT_PACKAGES, type JobKey } from "./scope/manifest.js";
import { resolveScope } from "./scope/resolve.js";

export interface CheckJob {
  name: string;
  directory: string;
  nodeVersion: number;
  installs: string[];
  commands: string[];
  matchGatewayImageNpm?: boolean;
}

const emulatorDirectories: Partial<Record<JobKey, string>> = {
  [JOBS.customerLifecycleEmulator]: "scripts",
  [JOBS.functionsEmulator]: "functions",
  [JOBS.gatewayEdgeEmulator]: "gateway-edge",
  [JOBS.glmControllerEmulator]: "glm-controller",
  [JOBS.octogeeApiEmulator]: "octogee-api",
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
  [JOBS.scripts]: 157,
  [JOBS.gatewayEdge]: 103,
  [JOBS.octogeeApi]: 93,
  [JOBS.desktopPackage]: 90,
  [JOBS.tests]: 72,
  [JOBS.glmController]: 39,
  [JOBS.site]: 36,
  [JOBS.core]: 27,
  [JOBS.functions]: 10,
  [JOBS.shared]: 6,
  [JOBS.desktop]: 6,
};

export function checkSeconds(name: string): number {
  return MEASURED_CHECK_SECONDS[name as JobKey] ?? 5;
}

function unitLaneAssignments(jobs: CheckJob[]): Map<string, string> {
  const units = jobs.filter(job => unitNames.has(job.name))
    .sort((a, b) => checkSeconds(b.name) - checkSeconds(a.name) || (a.name < b.name ? -1 : 1));
  const loads = UNIT_LANES.map(lane => ({ lane, seconds: 0 }));
  const assignments = new Map<string, string>();
  for (const job of units) {
    const lightest = loads.reduce((min, load) => load.seconds < min.seconds ? load : min);
    lightest.seconds += checkSeconds(job.name);
    assignments.set(job.name, lightest.lane);
  }
  return assignments;
}

export function selectCheckLane(jobs: CheckJob[], lane = "all"): CheckJob[] {
  if (lane === "all") return jobs;
  if (!CHECK_LANES.some(value => value === lane)) throw new Error(`Unknown CI lane: ${lane}`);
  const units = unitLaneAssignments(jobs);
  return jobs.filter(job => {
    const unit = units.get(job.name);
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

export function vitestOptions(script: string, emulated: boolean, concurrentLanes = 1, cpus = availableParallelism()): string {
  if (!script.includes("vitest") || script.includes("emulators:exec")) return "";
  if (emulated) return " -- --testTimeout=60000 --hookTimeout=60000 --maxWorkers=2";
  return ` -- --maxWorkers=${Math.max(1, Math.floor(cpus / concurrentLanes))}`;
}

function installsFor(directory: string): string[] {
  if (directory === "tests") return ["scripts", "shared", directory];
  if (directory === "octogee-api") return ["gateway-edge", "shared", directory];
  if (["app", "artifact-worker", "functions", "gateway-edge"].includes(directory)) return ["shared", directory];
  if (directory === "glm-controller") return ["scripts", directory];
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
    commands: ["npm run build", "CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --linux --publish never", "bash ../scripts/ci/verify-linux-package.sh"],
  };
  throw new Error(`No portable CI implementation for ${name}`);
}

const LINTED_SOURCE = /\.[cm]?[jt]sx?$/;
const TOKEN_SCANNED_SOURCE = /\.(?:[cm]?[jt]sx?|astro|css|html)$/;
const FULL_LINT_INPUTS = ["eslint.config.mjs", "scripts/ds-tokens.mjs", "design-system/tailwind-preset.mjs"];
const INFRASTRUCTURE_CONFIG = /(^|\/)Dockerfile[^/]*$|\.(?:tf|ya?ml)$|^(?:helm|terraform|infra|\.github)\//;
const RUST_AUDIT_INPUTS = ["artifact-worker/renderer/", "scripts/ci/", "ci/"];

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function qualityCommand(name: string, files?: string[]): string {
  const command = ["bash", "scripts/ci/quality.sh", name];
  if (files) command.push("--", ...files.map(shellQuote));
  return command.join(" ");
}

function qualityJobs(paths: string[], full: boolean): CheckJob[] {
  const job = (name: string, command: string): CheckJob =>
    ({ name, directory: ".", nodeVersion: DEFAULT_NODE_VERSION, installs: name === "eslint" || name === "knip" ? ["."] : [], commands: [command] });
  const jobs: CheckJob[] = [];
  if (full || paths.some(path => FULL_LINT_INPUTS.includes(path))) jobs.push(job("eslint", qualityCommand("eslint")));
  else if (paths.some(path => TOKEN_SCANNED_SOURCE.test(path))) jobs.push(job("eslint", qualityCommand("eslint", paths.filter(path => LINTED_SOURCE.test(path)))));
  if (full || paths.includes("knip.json")) jobs.push(job("knip", qualityCommand("knip")));
  jobs.push(job("gitleaks", qualityCommand("gitleaks")));
  const lockfiles = paths.filter(path => path.endsWith("package-lock.json"));
  if (full || paths.includes("osv-scanner.toml")) jobs.push(job("osv-scanner", qualityCommand("osv-scanner")));
  else if (lockfiles.length) jobs.push(job("osv-scanner", qualityCommand("osv-scanner", lockfiles)));
  if (full || paths.some(path => INFRASTRUCTURE_CONFIG.test(path))) jobs.push(job("trivy", qualityCommand("trivy")));
  if (full || paths.some(path => RUST_AUDIT_INPUTS.some(prefix => path.startsWith(prefix)))) jobs.push(job("cargo-audit", qualityCommand("cargo-audit")));
  return jobs;
}

export function checkPlan(paths: string[], group: "tests" | "quality" | "all" = "all", desktopPackage = false, full = false, deleted: ReadonlySet<string> = new Set()): CheckJob[] {
  const scope = full ? { jobs: [...ALL_JOBS], everything: true } : resolveScope(paths, deleted);
  const result = group === "quality" ? [] : scope.jobs.filter(name => desktopPackage || name !== JOBS.desktopPackage).map(testJob);
  if (group !== "quality" && desktopPackage && !result.some(job => job.name === JOBS.desktopPackage)) result.push(testJob(JOBS.desktopPackage));
  if (group === "tests") return result;
  return [...result, ...qualityJobs(paths, scope.everything)];
}

export async function executeChecks(jobs: CheckJob[], run: (job: CheckJob) => Promise<void>): Promise<void> {
  const failures: string[] = [];
  for (const job of jobs) {
    try { await run(job); }
    catch (error) { failures.push(`${job.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(`CI failed:\n${failures.join("\n")}`);
}
