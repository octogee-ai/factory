import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

function fakeNode(version: string): string {
  const bin = mkdtempSync(join(tmpdir(), "fake-node-"));
  const script = join(bin, "node");
  writeFileSync(script, `#!/bin/bash\nexec ${process.execPath} -e 'Object.defineProperty(process.versions, "node", { value: "${version}" }); eval(process.argv[1])' "\${@:2}"\n`);
  chmodSync(script, 0o755);
  return `${bin}:${process.env.PATH}`;
}
import { ALL_JOBS, UNIT_PACKAGES } from "../lib/scope/manifest.js";
import { CHECK_LANES, checkPlan, checkSeconds, executeChecks, nodeVersionCheck, selectCheckLane, dependencyInstaller, vitestOptions } from "../lib/ci-checks.js";

describe("portable Linux PR checks", () => {
  it("runs every registered test on a global change, leaving installer construction out of default CI", () => {
    const plan = checkPlan(["package-lock.json"], "tests");
    expect(plan.map(job => job.name).sort()).toEqual(ALL_JOBS.filter(name => name !== "desktop-package").sort());
    for (const pkg of UNIT_PACKAGES) {
      expect(plan.find(job => job.name === pkg.name)).toMatchObject({
        directory: pkg.dir, nodeVersion: pkg.nodeVersion ?? 24,
      });
    }
    expect(plan.find(job => job.name === "desktop-package")).toBeUndefined();
    expect(plan.find(job => job.name === "app")?.commands).toContain("npm test");
  });

  it("requires real PostgreSQL before core unit tests, which may depend on the qualified catalog", () => {
    const commands = checkPlan(["core/src/agent-store-credentials.ts"], "tests").find(job => job.name === "core")!.commands;
    expect(commands.indexOf("node ../scripts/ci/core-postgres.mjs")).toBeGreaterThan(0);
    expect(commands.indexOf("node ../scripts/ci/core-postgres.mjs")).toBeLessThan(commands.indexOf("npm test"));
  });

  it("runs every check on Node 24 except Cloud Functions, which stays on its Node 22 runtime", () => {
    const plan = checkPlan(["package-lock.json", "artifact-worker/renderer/Cargo.lock"], "all", true);
    const node22 = plan.filter(job => job.nodeVersion === 22).map(job => job.name).sort();
    expect(node22).toEqual(["functions", "functions-emulator"]);
    expect(plan.filter(job => job.nodeVersion !== 22).every(job => job.nodeVersion === 24)).toBe(true);
  });

  it("rejects a Node 24 toolchain older than Native qualification's 24.22.1 floor", () => {
    const check = (version: string) => () => execFileSync("/bin/bash", ["-euc", nodeVersionCheck(24)], {
      env: { ...process.env, PATH: fakeNode(version) }, stdio: "pipe",
    });
    expect(check("24.21.0")).toThrow(/requires Node >=24.22.1/);
    expect(check("22.20.0")).toThrow(/requires Node >=24.22.1/);
    expect(check("24.22.0")).toThrow(/requires Node >=24.22.1/);
    expect(check("24.22.1")).not.toThrow();
    expect(() => nodeVersionCheck(20)).toThrow("No Node 20 toolchain");
  });

  it("constructs installers only when explicitly requested", () => {
    expect(checkPlan(["desktop/package.json"], "tests").some(job => job.name === "desktop-package")).toBe(false);
    expect(checkPlan(["desktop/package.json"], "tests", true).find(job => job.name === "desktop-package")?.commands.join("\n")).toContain("--publish never");
  });

  it.each([{ paths: [] }, { paths: ["docs/INDEX.md"] }])("runs explicit installer packaging without a desktop diff: $paths", ({ paths }) => {
    expect(checkPlan(paths, "tests", true).map(job => job.name)).toContain("desktop-package");
  });

  it("keeps scoped checks and cross-package installs", () => {
    const plan = checkPlan(["gateway-edge/src/index.ts"], "tests");
    expect(plan.map(job => job.name)).toContain("octogee-api-emulator");
    expect(plan.map(job => job.name)).not.toContain("app");
    expect(plan.find(job => job.name === "octogee-api")?.installs).toContain("gateway-edge");
    expect(plan.find(job => job.name === "glm-controller-emulator")).toBeUndefined();
    expect(checkPlan(["docs/INDEX.md"], "tests")).toEqual([]);
  });

  it("runs every quality gate on a full run without deployment commands", () => {
    const plan = checkPlan(["docs/INDEX.md"], "quality", false, true);
    expect(plan.map(job => job.name)).toEqual(["eslint", "knip", "gitleaks", "osv-scanner", "trivy", "cargo-audit"]);
    expect(plan.map(job => job.commands)).toEqual(["eslint", "knip", "gitleaks", "osv-scanner", "trivy", "cargo-audit"].map(name => [`bash scripts/ci/quality.sh ${name}`]));
    expect(JSON.stringify(plan)).not.toMatch(/firebase deploy|helm upgrade|desiredRelease/);
  });

  it("runs every test job on a full run, whatever the diff", () => {
    expect(checkPlan(["docs/INDEX.md"], "tests", false, true).map(job => job.name).sort())
      .toEqual(ALL_JOBS.filter(name => name !== "desktop-package").sort());
  });

  it("scans only the diff for secrets on a docs-only pull request", () => {
    expect(checkPlan(["docs/INDEX.md"], "quality").map(job => job.commands)).toEqual([["bash scripts/ci/quality.sh gitleaks"]]);
  });

  it("lints changed sources and audits changed lockfiles without repo-wide lint or knip", () => {
    const plan = checkPlan(["app/src/App.tsx", "app/src/index.css", "app/package-lock.json", "docs/INDEX.md"], "quality");
    expect(plan.map(job => job.name)).toEqual(["eslint", "gitleaks", "osv-scanner"]);
    expect(plan[0].commands).toEqual(["bash scripts/ci/quality.sh eslint -- 'app/src/App.tsx'"]);
    expect(plan[2].commands).toEqual(["bash scripts/ci/quality.sh osv-scanner -- 'app/package-lock.json'"]);
  });

  it("runs the design-token scan for style-only changes without passing them to ESLint", () => {
    expect(checkPlan(["site/src/styles/global.css"], "quality")[0].commands).toEqual(["bash scripts/ci/quality.sh eslint --"]);
  });

  it("quotes changed paths so a file name cannot inject shell", () => {
    expect(checkPlan(["scripts/odd '$(touch x)'.ts"], "quality")[0].commands)
      .toEqual(["bash scripts/ci/quality.sh eslint -- 'scripts/odd '\\''$(touch x)'\\''.ts'"]);
  });

  it("runs repo-wide checks when their configuration changes", () => {
    expect(checkPlan(["eslint.config.mjs"], "quality")[0].commands).toEqual(["bash scripts/ci/quality.sh eslint"]);
    expect(checkPlan(["knip.json"], "quality").map(job => job.name)).toContain("knip");
    expect(checkPlan(["osv-scanner.toml"], "quality").find(job => job.name === "osv-scanner")?.commands).toEqual(["bash scripts/ci/quality.sh osv-scanner"]);
    expect(checkPlan(["package.json"], "quality").map(job => job.name)).toEqual(["eslint", "knip", "gitleaks", "osv-scanner", "trivy", "cargo-audit"]);
  });

  it("scans infrastructure configuration only when it changes", () => {
    expect(checkPlan(["helm/octogee/values.yaml"], "quality").map(job => job.name)).toContain("trivy");
    expect(checkPlan(["infra/gateway/Dockerfile"], "quality").map(job => job.name)).toContain("trivy");
    expect(checkPlan(["app/src/App.tsx"], "quality").map(job => job.name)).not.toContain("trivy");
    expect(checkPlan(["artifact-worker/renderer/Cargo.lock"], "quality").map(job => job.name)).toEqual(["gitleaks", "cargo-audit"]);
  });

  it("fails the aggregate check when an in-scope job fails, without skipping later checks", async () => {
    const jobs = checkPlan(["docs/INDEX.md"], "quality", false, true);
    const run = vi.fn(async (job: { name: string }) => {
      if (job.name === "gitleaks") throw new Error("secret found");
    });
    await expect(executeChecks(jobs, run)).rejects.toThrow("gitleaks");
    expect(run).toHaveBeenCalledTimes(jobs.length);
  });

  it("runs the artifact worker suite with its shared types installed", () => {
    expect(checkPlan(["artifact-worker/src/worker.ts"], "tests").find(job => job.name === "artifact-worker"))
      .toMatchObject({ directory: "artifact-worker", installs: ["shared", "artifact-worker"], commands: ["npm run typecheck", "npm test"] });
  });

  it.each(["package-lock.json", "gateway-edge/src/index.ts", "docs/INDEX.md"])("partitions every required check exactly once: %s", path => {
    const jobs = checkPlan([path]);
    const lanes = CHECK_LANES.flatMap(lane => selectCheckLane(jobs, lane));
    expect(lanes.map(job => job.name).sort()).toEqual(jobs.map(job => job.name).sort());
    expect(new Set(lanes.map(job => job.name)).size).toBe(lanes.length);
    expect(selectCheckLane(jobs, "emulators").every(job => job.name.endsWith("-emulator") || job.name === "firestore-rules")).toBe(true);
    expect(selectCheckLane(jobs, "quality").map(job => job.name)).toEqual(checkPlan([path], "quality").map(job => job.name));
  });

  const unitLanes = CHECK_LANES.filter(lane => lane.startsWith("units-"));
  const laneSeconds = (jobs: ReturnType<typeof checkPlan>) =>
    unitLanes.map(lane => selectCheckLane(jobs, lane).reduce((sum, job) => sum + checkSeconds(job.name), 0));

  it("balances a full run's unit lanes by measured check time", () => {
    const jobs = checkPlan(["package-lock.json"], "tests").filter(job => unitLanes.some(lane => selectCheckLane([job], lane).length));
    const weights = jobs.map(job => checkSeconds(job.name));
    const evenShare = weights.reduce((sum, value) => sum + value, 0) / unitLanes.length;
    expect(Math.max(...laneSeconds(jobs))).toBeLessThanOrEqual(Math.max(Math.max(...weights), evenShare) * 1.1);
  });

  it("spreads a partial plan's unit checks across separate lanes", () => {
    const jobs = checkPlan(["glm-controller/src/index.ts"], "tests");
    const occupied = unitLanes.filter(lane => selectCheckLane(jobs, lane).length > 0);
    expect(occupied).toHaveLength(2);
  });

  it("rejects an unknown lane instead of returning a green empty plan", () => {
    expect(() => selectCheckLane(checkPlan(["package-lock.json"]), "typo")).toThrow("Unknown CI lane");
  });

  it("installs shared dependencies once per toolchain, and retries a failed install", () => {
    const prepare = dependencyInstaller();
    const jobs = checkPlan(["package-lock.json"], "tests");
    const install = vi.fn();
    const job = jobs.find(value => value.name === "gateway-edge")!;
    prepare(job, install);
    prepare(job, install);
    expect(install.mock.calls.map(call => call[0])).toEqual(["shared", "gateway-edge"]);
    prepare({ ...job, matchGatewayImageNpm: true }, install);
    expect(install).toHaveBeenCalledTimes(4);
    const fail = vi.fn().mockImplementationOnce(() => { throw new Error("registry unavailable"); });
    const different = { ...job, installs: ["new-package"] };
    expect(() => prepare(different, fail)).toThrow("registry unavailable");
    prepare(different, fail);
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it("does not pass Vitest flags to Firebase's emulator CLI", () => {
    const script = 'firebase emulators:exec --only firestore,storage "vitest run"';
    expect(vitestOptions(script, false)).toBe("");
    expect(vitestOptions(script, true)).toBe("");
  });

  it("gives a lane the whole runner unless lanes share the host, and retains emulation timeouts", () => {
    expect(vitestOptions("vitest run", false, 1, 4)).toBe(" -- --maxWorkers=4");
    expect(vitestOptions("vitest run", false, 4, 24)).toBe(" -- --maxWorkers=6");
    expect(vitestOptions("vitest run", false, 4, 2)).toBe(" -- --maxWorkers=1");
    expect(vitestOptions("vitest run", true, 1, 8)).toContain("--testTimeout=60000 --hookTimeout=60000 --maxWorkers=2");
    expect(vitestOptions("node --test", false, 1, 8)).toBe("");
  });
});

describe("scoped quality script", () => {
  const source = fileURLToPath(new URL("../ci/quality.sh", import.meta.url));

  function workspace(): { root: string; calls: string; env: NodeJS.ProcessEnv } {
    const root = mkdtempSync(join(tmpdir(), "quality-sh-"));
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    copyFileSync(source, join(root, "scripts/ci/quality.sh"));
    writeFileSync(join(root, "scripts/ds-tokens.mjs"), "");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "calls");
    for (const tool of ["npx", "osv-scanner", "npm"]) {
      writeFileSync(join(bin, tool), `#!/bin/bash\nprintf '%s\\n' "${tool} $*" >> '${calls}'\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    return { root, calls, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
  }
  const run = (root: string, env: NodeJS.ProcessEnv, args: string[]) =>
    execFileSync("/bin/bash", ["scripts/ci/quality.sh", ...args], { cwd: root, env, encoding: "utf8" });

  it("lints only changed files that still exist, and skips ESLint when none remain", () => {
    const { root, calls, env } = workspace();
    writeFileSync(join(root, "kept.ts"), "");
    run(root, env, ["eslint", "--", "kept.ts", "deleted.ts"]);
    expect(readFileSync(calls, "utf8")).toBe("npx eslint --format=stylish --max-warnings=0 --no-warn-ignored -- kept.ts\n");
    expect(run(root, env, ["eslint", "--", "deleted.ts"])).toContain("No changed lint sources remain");
    expect(readFileSync(calls, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("lints the whole repository without a file list", () => {
    const { root, calls, env } = workspace();
    run(root, env, ["eslint"]);
    expect(readFileSync(calls, "utf8")).toBe("npm run lint -- --format=stylish --max-warnings=0\n");
  });

  it("audits only changed lockfiles that still exist", () => {
    const { root, calls, env } = workspace();
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app/package-lock.json"), "{}");
    run(root, env, ["osv-scanner", "--", "app/package-lock.json", "gone/package-lock.json"]);
    expect(readFileSync(calls, "utf8")).toBe("osv-scanner scan source --config=osv-scanner.toml --lockfile=app/package-lock.json\n");
    expect(run(root, env, ["osv-scanner", "--", "gone/package-lock.json"])).toContain("No changed lockfiles remain");
  });
});
