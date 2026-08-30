import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hydrateBuilderToolchain,
  installBuilderToolchainDependencies,
  parseBuilderToolchainLock,
  readToolchainStatus,
} from "../lib/builder-toolchain-hydrator.js";
import { resolveToolchainCommand } from "../lib/builder-toolchain-wrapper.js";

const tempRoots: string[] = [];
const PROXY_REGISTRY =
  "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/";
const CAPABILITY = "t".repeat(43);

const registryCredentials = () => Promise.resolve({
  registryUrl: PROXY_REGISTRY,
  token: CAPABILITY,
  expiresAt: "2099-01-01T00:00:00.000Z",
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-toolchain-lock-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lockFixture(): Record<string, unknown> {
  return {
    name: "@octogee/builder-toolchain",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "@octogee/builder-toolchain",
        version: "1.0.0",
        dependencies: {
          "@anthropic-ai/claude-code": "2.1.251",
          "@openai/codex": "0.151.0",
        },
      },
      "node_modules/@anthropic-ai/claude-code": {
        version: "2.1.251",
        resolved: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.251.tgz",
        integrity: "sha512-Y2xhdWRl",
      },
      "node_modules/@openai/codex": {
        version: "0.151.0",
        resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0.tgz",
        integrity: "sha512-Y29kZXg=",
      },
    },
  };
}

async function writePinnedInputs(home: string): Promise<{
  packageJsonPath: string;
  packageLockPath: string;
  packageLockSha256: string;
}> {
  const packageJsonPath = path.join(home, "package.json");
  const packageLockPath = path.join(home, "package-lock.json");
  const packageJson = {
    name: "@octogee/builder-toolchain",
    version: "1.0.0",
    private: true,
    dependencies: {
      "@anthropic-ai/claude-code": "2.1.251",
      "@openai/codex": "0.151.0",
    },
    allowScripts: {
      "@anthropic-ai/claude-code@2.1.251": true,
    },
  };
  const rawLock = `${JSON.stringify(lockFixture())}\n`;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson)}\n`);
  await fs.writeFile(packageLockPath, rawLock);
  return { packageJsonPath, packageLockPath, packageLockSha256: sha256(rawLock) };
}

async function fakeInstall(destination: string): Promise<void> {
  const bin = path.join(destination, "node_modules", ".bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\necho '2.1.251 (Claude Code)'\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.151.0'\n", { mode: 0o755 });
}

describe("Builder npm toolchain lock", () => {
  it("accepts only the two exact CLI dependencies with registry integrity", () => {
    expect(parseBuilderToolchainLock(lockFixture())).toEqual({
      schemaVersion: 1,
      id: "npm-lock-sha256",
      commands: {
        claude: "node_modules/.bin/claude",
        codex: "node_modules/.bin/codex",
      },
      versions: { claude: "2.1.251", codex: "0.151.0" },
    });

    const missingIntegrity = lockFixture();
    delete (missingIntegrity.packages as Record<string, Record<string, unknown>>)[
      "node_modules/@openai/codex"
    ].integrity;
    expect(() => parseBuilderToolchainLock(missingIntegrity)).toThrow(/invalid-toolchain-lock/);
  });

  it("installs after pin verification into a content-addressed HOME object and activates atomically", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const installDependencies = vi.fn(fakeInstall);
    const registryCredentialsProvider = vi.fn(registryCredentials);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider,
      installDependencies,
    })).resolves.toMatchObject({ status: "ready" });

    const objectPath = path.join(root, "objects", `sha256-${pin.packageLockSha256}`);
    expect(installDependencies).toHaveBeenCalledWith(expect.stringContaining(
      `${path.sep}staging${path.sep}`,
    ), {
      cachePath: path.join(root, "npm-cache"),
      registryUrl: PROXY_REGISTRY,
      authToken: CAPABILITY,
      signal: undefined,
    });
    expect(await fs.readlink(path.join(root, "active"))).toBe(
      `objects/sha256-${pin.packageLockSha256}`,
    );
    await expect(resolveToolchainCommand({ root, command: "claude" })).resolves.toMatchObject({
      kind: "ready",
      executable: path.join(await fs.realpath(objectPath), "node_modules", ".bin", "claude"),
    });
    await expect(readToolchainStatus(root)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects lock drift before invoking npm", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const installDependencies = vi.fn(fakeInstall);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      packageLockSha256: "0".repeat(64),
      registryCredentialsProvider: registryCredentials,
      installDependencies,
    })).rejects.toMatchObject({ reasonCode: "toolchain-lock-digest-mismatch" });
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it("requires the exact pinned Claude postinstall approval before invoking npm", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const packageJson = JSON.parse(await fs.readFile(pin.packageJsonPath, "utf8")) as {
      allowScripts?: Record<string, boolean>;
    };
    packageJson.allowScripts = { "@anthropic-ai/claude-code": true };
    await fs.writeFile(pin.packageJsonPath, `${JSON.stringify(packageJson)}\n`);
    const installDependencies = vi.fn(fakeInstall);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: registryCredentials,
      installDependencies,
    })).rejects.toMatchObject({ reasonCode: "invalid-toolchain-package" });
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it("rejects an installed Claude placeholder instead of publishing a false ready state", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: registryCredentials,
      installDependencies: async (destination) => {
        const bin = path.join(destination, "node_modules", ".bin");
        await fs.mkdir(bin, { recursive: true });
        await fs.writeFile(
          path.join(bin, "claude"),
          "#!/bin/sh\necho 'Error: claude native binary not installed.' >&2\nexit 1\n",
          { mode: 0o755 },
        );
        await fs.writeFile(
          path.join(bin, "codex"),
          "#!/bin/sh\necho 'codex-cli 0.151.0'\n",
          { mode: 0o755 },
        );
      },
    })).rejects.toMatchObject({ reasonCode: "invalid-command-version" });
    await expect(readToolchainStatus(root)).resolves.toMatchObject({ status: "failed" });
  });

  it("logs proxy failure timing and falls back directly without a token", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const log = vi.fn();
    const installDependencies = vi.fn(fakeInstall);
    const ticks = [100, 140];

    await hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: async () => { throw new Error("metadata unavailable"); },
      installDependencies,
      log,
      nowMs: () => ticks.shift() ?? 140,
    });

    expect(installDependencies).toHaveBeenCalledTimes(1);
    expect(installDependencies.mock.calls[0]?.[1]).toMatchObject({
      registryUrl: "https://registry.npmjs.org/",
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/credentials unavailable.*direct npm/));
    expect(log).toHaveBeenCalledWith(
      "[builder-toolchain] npm install registry=direct outcome=ready durationMs=40",
    );
  });

  it("never sends the capability to a registry outside the in-cluster proxy", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const installDependencies = vi.fn(fakeInstall);

    await hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: async () => ({
        registryUrl: "https://attacker.example/npm/",
        token: CAPABILITY,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      installDependencies,
    });

    expect(installDependencies).toHaveBeenCalledTimes(1);
    expect(installDependencies.mock.calls[0]?.[1]).toMatchObject({
      registryUrl: "https://registry.npmjs.org/",
    });
    expect(installDependencies.mock.calls[0]?.[1]).not.toHaveProperty("authToken");
  });

  it("passes proxy auth only through the npm child environment and removes its config", async () => {
    const destination = await tempRoot();
    const fakeBin = path.join(destination, "fake-bin");
    const witness = path.join(destination, "witness.json");
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, "npm"), `#!/bin/sh
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.env.WITNESS, JSON.stringify({token:process.env.NODE_AUTH_TOKEN,npmrc:fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG,"utf8"),npmrcPath:process.env.NPM_CONFIG_USERCONFIG,args:process.argv.slice(1)}))' "$@"
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    const previousWitness = process.env.WITNESS;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    process.env.WITNESS = witness;
    try {
      await installBuilderToolchainDependencies(destination, {
        cachePath: path.join(destination, "cache"),
        registryUrl: "https://proxy.example/npm/",
        authToken: "secret-token",
        npmExecutable: path.join(fakeBin, "npm"),
      });
    } finally {
      process.env.PATH = previousPath;
      if (previousWitness === undefined) delete process.env.WITNESS;
      else process.env.WITNESS = previousWitness;
    }
    const observed = JSON.parse(await fs.readFile(witness, "utf8")) as {
      token: string;
      npmrc: string;
      npmrcPath: string;
      args: string[];
    };
    expect(observed.token).toBe("secret-token");
    expect(observed.npmrc).toContain("_authToken=${NODE_AUTH_TOKEN}");
    expect(observed.npmrc).not.toContain("secret-token");
    expect(observed.args).toContain("--include=optional");
    await expect(fs.lstat(observed.npmrcPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an ambient npm token from the unauthenticated direct fallback child", async () => {
    const destination = await tempRoot();
    const fakeNpm = path.join(destination, "npm");
    const witness = path.join(destination, "witness.json");
    await fs.writeFile(fakeNpm, `#!/bin/sh
node -e 'require("node:fs").writeFileSync(process.env.WITNESS, JSON.stringify({token:process.env.NODE_AUTH_TOKEN}))'
`, { mode: 0o755 });
    const previousToken = process.env.NODE_AUTH_TOKEN;
    const previousWitness = process.env.WITNESS;
    process.env.NODE_AUTH_TOKEN = "ambient-secret";
    process.env.WITNESS = witness;
    try {
      await installBuilderToolchainDependencies(destination, {
        cachePath: path.join(destination, "cache"),
        registryUrl: "https://registry.npmjs.org/",
        npmExecutable: fakeNpm,
      });
    } finally {
      if (previousToken === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = previousToken;
      if (previousWitness === undefined) delete process.env.WITNESS;
      else process.env.WITNESS = previousWitness;
    }

    expect(JSON.parse(await fs.readFile(witness, "utf8"))).toEqual({});
  });
});
