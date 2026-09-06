import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const gate = resolve(import.meta.dirname, "../../infra/gateway/verify-runtime-image.sh");
const roots: string[] = [];

type ImageShape = {
  bundledMattermost?: boolean;
  stagedPlugins?: string[];
  globalPackages?: string[];
  tools?: string[];
  chromium?: boolean;
};

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function executable(path: string) {
  writeFileSync(path, "#!/usr/bin/env bash\n");
  chmodSync(path, 0o755);
}

function fakeImage({
  bundledMattermost = true,
  stagedPlugins = ["parallel-plugin", "codex"],
  globalPackages = ["@anthropic-ai/claude-code", "@openai/codex"],
  tools = ["claude", "codex"],
  chromium = true,
}: ImageShape = {}) {
  const root = mkdtempSync(join(tmpdir(), "gateway-runtime-image-"));
  roots.push(root);
  const globalRoot = join(root, "global");
  const runtimeRoot = join(root, "runtime-deps");
  const toolBin = join(root, "bin");
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(toolBin, { recursive: true });

  if (bundledMattermost) {
    const bundled = join(globalRoot, "openclaw", "dist", "extensions", "mattermost");
    mkdirSync(bundled, { recursive: true });
    writeFileSync(join(bundled, "package.json"), JSON.stringify({ name: "@openclaw/mattermost" }));
  }
  for (const plugin of stagedPlugins) {
    mkdirSync(join(runtimeRoot, "projects", plugin, "node_modules", "@openclaw", plugin), { recursive: true });
  }
  for (const packageName of globalPackages) {
    mkdirSync(join(globalRoot, packageName), { recursive: true });
  }
  for (const tool of tools) executable(join(toolBin, tool));
  const chromiumBin = join(root, "chromium");
  if (chromium) executable(chromiumBin);

  const lockPath = join(root, "package-lock.json");
  const groupsPath = join(root, "groups.json");
  writeFileSync(lockPath, '{"lockfileVersion":3}\n');
  writeFileSync(groupsPath, '{"groups":[]}\n');

  return {
    env: {
      OPENCLAW_RUNTIME_DEPS_ROOT: runtimeRoot,
      NPM_GLOBAL_ROOT: globalRoot,
      OCTOGEE_TOOL_BIN_DIR: toolBin,
      OCTOGEE_CHROMIUM_BIN: chromiumBin,
    },
    toolchainEnv: {
      OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256: sha256('{"lockfileVersion":3}\n'),
      OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH: lockPath,
      OCTOGEE_BUILDER_TOOL_GROUPS_SHA256: sha256('{"groups":[]}\n'),
      OCTOGEE_BUILDER_TOOL_GROUPS_PATH: groupsPath,
    },
    globalRoot,
  };
}

function verify(profile: string, env: Record<string, string>) {
  const { PATH, HOME } = process.env;
  return spawnSync("bash", [gate, profile], {
    encoding: "utf8",
    env: { PATH: PATH ?? "", HOME: HOME ?? "", ...env },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gateway runtime image gate", () => {
  it("passes a gateway image with bundled Mattermost, staged plugins, and the agent CLIs", () => {
    const image = fakeImage();

    const result = verify("gateway", image.env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OpenClaw runtime image gate: PASS (gateway)");
  });

  it("rejects an unknown profile", () => {
    const result = verify("operator", fakeImage().env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown image profile: operator");
  });

  it("rejects Mattermost staged as a runtime dependency instead of bundled", () => {
    const image = fakeImage({ stagedPlugins: ["mattermost", "parallel-plugin", "codex"] });

    const result = verify("gateway", image.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("@openclaw/mattermost must not be staged");
  });

  it("rejects a missing bundled Mattermost extension", () => {
    const result = verify("gateway", fakeImage({ bundledMattermost: false }).env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Mattermost is not bundled");
  });

  it.each(["parallel-plugin", "codex"])("rejects a staged tree missing @openclaw/%s", (missing) => {
    const image = fakeImage({
      stagedPlugins: ["parallel-plugin", "codex"].filter((name) => name !== missing),
    });

    const result = verify("gateway", image.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`@openclaw/${missing} is absent`);
  });

  it.each(["@anthropic-ai/claude-code", "@openai/codex"])("rejects a missing global %s", (missing) => {
    const image = fakeImage({
      globalPackages: ["@anthropic-ai/claude-code", "@openai/codex"].filter((name) => name !== missing),
    });

    const result = verify("gateway", image.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${missing} is absent`);
  });

  it.each(["claude", "codex"])("rejects a non-executable %s launcher", (tool) => {
    const image = fakeImage({ tools: ["claude", "codex"].filter((name) => name !== tool) });

    const result = verify("gateway", image.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`/${tool} is not executable`);
  });

  it("rejects a globally installed @sparticuz/chromium payload", () => {
    const image = fakeImage();
    mkdirSync(join(image.globalRoot, "@sparticuz", "chromium"), { recursive: true });

    const result = verify("gateway", image.env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("@sparticuz/chromium must not be installed");
  });

  it("rejects a missing system chromium", () => {
    const result = verify("gateway", fakeImage({ chromium: false }).env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("chromium is not executable");
  });
});

describe("builder runtime image gate", () => {
  it("passes when the toolchain catalog matches its recorded digests", () => {
    const image = fakeImage();

    const result = verify("builder", { ...image.env, ...image.toolchainEnv });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OpenClaw runtime image gate: PASS (builder)");
  });

  it("does not require the toolchain catalog for the gateway profile", () => {
    const image = fakeImage();

    const result = verify("gateway", image.env);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256",
    "OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH",
    "OCTOGEE_BUILDER_TOOL_GROUPS_SHA256",
    "OCTOGEE_BUILDER_TOOL_GROUPS_PATH",
  ])("rejects a Builder image missing %s", (missing) => {
    const image = fakeImage();
    const toolchainEnv = Object.fromEntries(
      Object.entries(image.toolchainEnv).filter(([name]) => name !== missing),
    );

    const result = verify("builder", { ...image.env, ...toolchainEnv });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${missing} is unset in the Builder image`);
  });

  it("rejects a toolchain lock that drifted from its recorded digest", () => {
    const image = fakeImage();
    writeFileSync(image.toolchainEnv.OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH, "{}\n");

    const result = verify("builder", { ...image.env, ...image.toolchainEnv });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Builder toolchain lock does not match");
  });

  it("rejects a tool group catalog that drifted from its recorded digest", () => {
    const image = fakeImage();
    writeFileSync(image.toolchainEnv.OCTOGEE_BUILDER_TOOL_GROUPS_PATH, "{}\n");

    const result = verify("builder", { ...image.env, ...image.toolchainEnv });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Builder tool groups do not match");
  });
});
