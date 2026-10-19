import { JOBS, UNIT_PACKAGES, type JobKey } from "./scope/manifest.js";
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

export const NODE_MINIMUMS: Record<number, string> = { 22: "22.0.0", 24: "24.12.0" };

export function nodeVersionCheck(nodeVersion: number): string {
  const minimum = NODE_MINIMUMS[nodeVersion];
  if (!minimum) throw new Error(`No Node ${nodeVersion} toolchain is declared for CI`);
  return `node -e 'const [major, minor] = process.versions.node.split(".").map(Number); const [, wantMinor] = "${minimum}".split(".").map(Number); if (major !== ${nodeVersion} || minor < wantMinor) throw new Error("CI requires Node >=${minimum} <${nodeVersion + 1} (found " + process.versions.node + "); set CI_NODE_${nodeVersion}_BIN or use ci:docker")'`;
}

export const CHECK_LANES = ["units-1", "units-2", "units-3", "emulators", "quality"] as const;
const unitNames: readonly string[] = [...UNIT_PACKAGES.map(pkg => pkg.name), JOBS.desktopPackage];

export function selectCheckLane(jobs: CheckJob[], lane = "all"): CheckJob[] {
  if (lane === "all") return jobs;
  if (!CHECK_LANES.some(value => value === lane)) throw new Error(`Unknown CI lane: ${lane}`);
  return jobs.filter(job => {
    if (job.name === JOBS.app) return lane === "units-3";
    const unit = unitNames.indexOf(job.name);
    if (unit !== -1) return lane === `units-${unit % 3 + 1}`;
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

export function vitestOptions(script: string, emulated: boolean): string {
  if (!script.includes("vitest") || script.includes("emulators:exec")) return "";
  return emulated ? " -- --testTimeout=60000 --hookTimeout=60000 --maxWorkers=2" : " -- --maxWorkers=4";
}

function installsFor(directory: string): string[] {
  if (directory === "tests") return ["scripts", "shared", directory];
  if (directory === "octogee-api") return ["gateway-edge", "shared", directory];
  if (["app", "functions", "gateway-edge"].includes(directory)) return ["shared", directory];
  if (directory === "glm-controller") return ["scripts", directory];
  return [directory];
}

function testJob(name: JobKey): CheckJob {
  const pkg = UNIT_PACKAGES.find(value => value.name === name);
  if (pkg) return {
    name, directory: pkg.dir, nodeVersion: pkg.nodeVersion ?? 22,
    matchGatewayImageNpm: pkg.matchGatewayImageNpm,
    installs: installsFor(pkg.dir),
    commands: [...(name === JOBS.site ? ["npx playwright install chromium"] : []), pkg.typecheck, "npm test"],
  };
  const directory = emulatorDirectories[name];
  if (directory) return { name, directory, nodeVersion: 22, installs: installsFor(directory), commands: ["npm run test:emulator"] };
  if (name === JOBS.app) return { name, directory: "app", nodeVersion: 24, installs: installsFor("app"), commands: ["npm run typecheck", "npm test"] };
  if (name === JOBS.firestoreRules) return { name, directory: "firestore-rules-tests", nodeVersion: 24, installs: ["firestore-rules-tests"], commands: ["npm test"] };
  if (name === JOBS.desktopPackage) return {
    name, directory: "desktop", nodeVersion: 22, installs: ["desktop"],
    commands: ["npm run build", "CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --linux --publish never", "bash ../scripts/ci/verify-linux-package.sh"],
  };
  throw new Error(`No portable CI implementation for ${name}`);
}

export function checkPlan(paths: string[], group: "tests" | "quality" | "all" = "all", desktopPackage = false): CheckJob[] {
  const result = group === "quality" ? [] : resolveScope(paths).jobs.filter(name => desktopPackage || name !== JOBS.desktopPackage).map(testJob);
  if (group !== "quality" && desktopPackage && !result.some(job => job.name === JOBS.desktopPackage)) result.push(testJob(JOBS.desktopPackage));
  if (group === "tests") return result;
  for (const name of ["eslint", "knip", "gitleaks", "osv-scanner", "trivy", "cargo-audit"]) {
    if (name === "cargo-audit" && !paths.some(path => path.startsWith("artifact-worker/renderer/") || path.startsWith("scripts/ci/") || path.startsWith("ci/"))) continue;
    result.push({ name, directory: ".", nodeVersion: 22, installs: name === "eslint" || name === "knip" ? ["."] : [], commands: [`bash scripts/ci/quality.sh ${name}`] });
  }
  return result;
}

export async function executeChecks(jobs: CheckJob[], run: (job: CheckJob) => Promise<void>): Promise<void> {
  const failures: string[] = [];
  for (const job of jobs) {
    try { await run(job); }
    catch (error) { failures.push(`${job.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(`CI failed:\n${failures.join("\n")}`);
}
