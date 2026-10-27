import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlan, executeChecks, jobLabel, nodeVersionCheck, selectCheckLane, dependencyInstaller, vitestOptions, type CheckJob } from "../lib/ci-checks.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const group = value("group") ?? "all";
if (!["all", "tests", "quality"].includes(group)) throw new Error("--group must be all, tests, or quality");
const concurrentLanes = Number(value("concurrent-lanes") ?? 1);
if (!Number.isInteger(concurrentLanes) || concurrentLanes < 1) throw new Error("--concurrent-lanes must be a positive integer");
const git = (...argv: string[]) => execFileSync("/usr/bin/git", argv, { cwd: root, encoding: "utf8" }).trim();
const head = git("rev-parse", "--verify", `${value("head") ?? "HEAD"}^{commit}`);
const base = git("rev-parse", "--verify", `${value("base") ?? "origin/main"}^{commit}`);
const fork = git("merge-base", base, head);
const changed = (...argv: string[]) => git("diff", "--name-only", ...argv).split("\n").filter(Boolean);
const paths = args.includes("--all") ? ["package-lock.json", "ci/"] : changed(fork, head);
const deleted = new Set(args.includes("--all") ? [] : changed("--diff-filter=D", fork, head));
if (!value("head")) {
  paths.push(...changed("HEAD"), ...git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean));
  for (const path of changed("--diff-filter=D", "HEAD")) deleted.add(path);
}
const full = args.includes("--all");
const jobs = selectCheckLane(checkPlan(paths, group as "all" | "tests" | "quality", value("check") === "desktop-package", full, deleted), value("lane")).filter(job => !value("check") || job.name === value("check"));
if (value("check") && !jobs.length) throw new Error(`Check ${value("check")} is not in scope`);
if (args.includes("--plan")) {
  console.log(JSON.stringify(jobs, null, 2));
} else {
  const prepare = dependencyInstaller();
  await executeChecks(jobs, async (job: CheckJob) => {
    console.log(`\n== ${jobLabel(job)} ==`);
    const nodeBin = process.env[`CI_NODE_${job.nodeVersion}_BIN`] ?? `/opt/node${job.nodeVersion}/bin`;
    const path = existsSync(nodeBin) ? `${nodeBin}${delimiter}${process.env.PATH}` : process.env.PATH;
    const env = { ...process.env, PATH: path, CI: "true", CI_BASE_SHA: base, CI_HEAD_SHA: head, CI_REPO_ROOT: root, CI_INCLUDE_WORKING_TREE: String(!value("head")) };
    const run = (command: string, directory = root) => execFileSync("/bin/bash", ["-euc", command], { cwd: directory, env, stdio: "inherit" });
    run(nodeVersionCheck(job.nodeVersion));
    if (job.matchGatewayImageNpm) {
      const npmVersion = readFileSync(resolve(root, "infra/gateway/Dockerfile.base"), "utf8").match(/^ARG NPM_VERSION=([\d.]+)$/m)?.[1];
      if (!npmVersion) throw new Error("Gateway npm version is missing");
      run(`npm install --prefix /tmp/octogee-ci-npm-${job.nodeVersion} npm@${npmVersion} --ignore-scripts --no-audit --no-fund`);
      env.PATH = `/tmp/octogee-ci-npm-${job.nodeVersion}/node_modules/.bin${delimiter}${path}`;
    }
    prepare(job, directory => run("npm ci --no-audit --no-fund", resolve(root, directory)));
    for (const command of job.commands) {
      const script = command === "npm test" ? JSON.parse(readFileSync(resolve(root, job.directory, "package.json"), "utf8")).scripts?.test : "";
      const options = vitestOptions(script, process.env.CI_EMULATED === "true", concurrentLanes, undefined, job.shard);
      run(command + options, resolve(root, job.directory));
    }
  });
}
