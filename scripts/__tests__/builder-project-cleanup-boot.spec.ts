import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runBuilderProjectCleanup } from "../entrypoints/clean-builder-project-placeholders.js";
import { prepareConfiguredBuilderTarget } from "../entrypoints/surge-openclaw-supervisor.js";
import { TEST_CLAIM_GATEWAY_ID, withBuilderClaim, writeTestBuilderClaim } from "./helpers/builder-claim.js";

const repo = path.resolve(import.meta.dirname, "../..");
let root: string;
let state: string;
let projects: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "builder-project-boot-"));
  state = path.join(root, ".openclaw");
  projects = path.join(state, "customers/alice/projects");
  await mkdir(path.join(projects, "rvshare"), { recursive: true });
  await mkdir(path.join(projects, "demo"));
  await writeFile(path.join(projects, "demo/local.txt"), "retain local work");
  await writeFile(path.join(projects, "demo/.git"), "gitdir: /private/metadata/demo.git\n");
  await mkdir(path.join(projects, ".octogee-state"));
  await writeFile(path.join(projects, ".octogee-state/demo.json"), "ready marker");
  await writeFile(path.join(projects, ".octogee-state/demo.assets.json"), "asset state");
  await mkdir(path.join(state, "project-storage"));
  await writeFile(path.join(state, "project-storage/alice.json"), '"unchanged generation"');
  await mkdir(path.join(state, "project-imports/alice/rvshare"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function boot(gatewayClass: string, runtime: string, expectEmptyRemoved: boolean) {
  const prefix = (await readFile(path.join(repo, "infra/gateway/entrypoint.sh"), "utf8"))
    .split('mkdir -p "$HOME/.ssh"')[0]
    .replace("export OPENCLAW_DIR=/home/node/.openclaw", `export OPENCLAW_DIR='${state}'`)
    .replace(/BUILDER_SLUG=""\nif [^\n]*\n[\s\S]*?\nfi\n/u, "BUILDER_SLUG=alice\n")
    .replaceAll("/octogee", repo);
  if (gatewayClass === "builder") writeTestBuilderClaim(state, "alice");
  const reader = path.join(root, "reader.mjs");
  await writeFile(reader, `import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(fs.existsSync(process.env.OPENCLAW_DIR+'/customers/alice/projects/rvshare'),${!expectEmptyRemoved});console.log('runtime-reader-started');`);
  return spawnSync("sh", ["-s"], {
    input: `${prefix}\nnode '${reader}'\n`, encoding: "utf8",
    env: { ...process.env, HOME: root, GATEWAY_CLASS: gatewayClass, GATEWAY_RUNTIME_KIND: runtime, GATEWAY_ID: TEST_CLAIM_GATEWAY_ID },
  });
}

it.each(["gce-vm", "cluster"])("cleans retained %s Builder placeholders before runtime readers without reinitializing storage", async runtime => {
  const result = await boot("builder", runtime, true);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("runtime-reader-started");
  expect(await readFile(path.join(projects, "demo/local.txt"), "utf8")).toBe("retain local work");
  expect(await readFile(path.join(projects, "demo/.git"), "utf8")).toBe("gitdir: /private/metadata/demo.git\n");
  expect(await readFile(path.join(projects, ".octogee-state/demo.json"), "utf8")).toBe("ready marker");
  expect(await readFile(path.join(projects, ".octogee-state/demo.assets.json"), "utf8")).toBe("asset state");
  expect(await readFile(path.join(state, "project-storage/alice.json"), "utf8")).toBe('"unchanged generation"');
  expect(await readdir(path.join(state, "project-imports/alice/rvshare"))).toEqual([]);
});

it("leaves Shared customer workspaces unchanged", async () => {
  const result = await boot("shared", "cluster", false);
  expect(result.status, result.stderr).toBe(0);
  expect(await readdir(path.join(projects, "rvshare"))).toEqual([]);
});

it("fails boot before runtime readers if an empty project is a symlink", async () => {
  await rm(path.join(projects, "rvshare"), { recursive: true });
  const foreign = path.join(root, "foreign");
  await mkdir(foreign);
  await symlink(foreign, path.join(projects, "rvshare"));
  const result = await boot("builder", "gce-vm", true);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("runtime-reader-started");
  expect(await readdir(foreign)).toEqual([]);
});

it("cleans directory shells imported after boot before a held Builder is released", async () => {
  const run = vi.fn(async (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    if (args[0].endsWith("clean-builder-project-placeholders.ts")) await runBuilderProjectCleanup(options.env);
  });
  await prepareConfiguredBuilderTarget(withBuilderClaim({ OPENCLAW_DIR: state }, "alice"), run);
  await expect(readdir(path.join(projects, "rvshare"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(run.mock.calls.map(([, args]) => path.basename(args[0]))).toEqual([
    "pre-boot-config.ts", "apply-gateway-class-policy.mjs", "ensure-configured-agent-runtime-dirs.ts", "clean-builder-project-placeholders.ts",
  ]);
  expect(await readFile(path.join(projects, ".octogee-state/demo.json"), "utf8")).toBe("ready marker");
});

it("permits a fresh Builder with no existing projects without creating a working set", async () => {
  await rm(path.join(state, "customers"), { recursive: true });
  await runBuilderProjectCleanup(withBuilderClaim({ GATEWAY_CLASS: "builder", OPENCLAW_DIR: state }, "alice"));
  await expect(readdir(path.join(state, "customers"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a symlink customer ancestor without entering its work", async () => {
  await rm(path.join(state, "customers"), { recursive: true });
  const foreign = path.join(root, "foreign");
  await mkdir(path.join(foreign, "alice/projects/demo"), { recursive: true });
  await writeFile(path.join(foreign, "alice/projects/demo/local.txt"), "foreign work");
  await symlink(foreign, path.join(state, "customers"));
  await expect(runBuilderProjectCleanup(withBuilderClaim({ GATEWAY_CLASS: "builder", OPENCLAW_DIR: state }, "alice"))).rejects.toThrow();
  expect(await readFile(path.join(foreign, "alice/projects/demo/local.txt"), "utf8")).toBe("foreign work");
});

it.each([
  { label: "a shared gateway", gatewayClass: "shared", claimed: true },
  { label: "a Builder without a claim", gatewayClass: "builder", claimed: false },
])("rejects cleanup for $label", async ({ gatewayClass, claimed }) => {
  const env = { GATEWAY_CLASS: gatewayClass, OPENCLAW_DIR: state, GATEWAY_ID: TEST_CLAIM_GATEWAY_ID, GATEWAY_BUILDER_SLUG: "alice" };
  await expect(runBuilderProjectCleanup(claimed ? withBuilderClaim(env, "alice") : env)).rejects.toThrow();
  expect(await readdir(path.join(projects, "rvshare"))).toEqual([]);
});
