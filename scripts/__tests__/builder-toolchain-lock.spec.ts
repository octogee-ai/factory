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
import { parseBuilderToolGroups, type BuilderToolGroups } from "../lib/builder-tool-groups.js";
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

const NPM_PACKAGES = {
  "@anthropic-ai/claude-code": "2.1.270",
  "@openai/codex": "0.154.0",
  "@sparticuz/chromium": "149.0.0",
  "firebase-tools": "15.28.2",
  "npm-check-updates": "23.1.0",
  "pnpm": "12.4.1",
  "tsx": "4.23.13",
  "typescript": "5.9.3",
};

function groupsFixture(): BuilderToolGroups {
  return parseBuilderToolGroups({
    schemaVersion: 1,
    groups: [
      {
        id: "agent-clis",
        enabled: true,
        delivery: "npm",
        npmPackages: {
          "@anthropic-ai/claude-code": "2.1.270",
          "@openai/codex": "0.154.0",
        },
        commands: ["claude", "codex"],
      },
      {
        id: "browser",
        enabled: true,
        delivery: "npm",
        npmPackages: { "@sparticuz/chromium": "149.0.0" },
        commands: ["chromium"],
      },
      {
        id: "web-development",
        enabled: true,
        delivery: "npm",
        npmPackages: {
          "firebase-tools": "15.28.2",
          "npm-check-updates": "23.1.0",
          "pnpm": "12.4.1",
          "tsx": "4.23.13",
          "typescript": "5.9.3",
        },
        commands: ["firebase", "ncu", "pnpm", "tsx", "tsc"],
      },
    ],
    pythonPackages: [],
    standaloneTools: {},
  });
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
        dependencies: NPM_PACKAGES,
      },
      "node_modules/@anthropic-ai/claude-code": {
        version: "2.1.270",
        resolved: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.270.tgz",
        integrity: "sha512-Y2xhdWRl",
        hasInstallScript: true,
        bin: { claude: "bin/claude.exe" },
      },
      "node_modules/@openai/codex": {
        version: "0.154.0",
        resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.154.0.tgz",
        integrity: "sha512-Y29kZXg=",
        bin: { codex: "bin/codex.js" },
      },
      "node_modules/@sparticuz/chromium": {
        version: "149.0.0",
        resolved: "https://registry.npmjs.org/@sparticuz/chromium/-/chromium-149.0.0.tgz",
        integrity: "sha512-Y2hyb21pdW0=",
      },
      ...Object.fromEntries(Object.entries(NPM_PACKAGES)
        .filter(([name]) => !name.startsWith("@"))
        .map(([name, version]) => [`node_modules/${name}`, {
          version,
          resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
          integrity: "sha512-Y2FjaGVk",
          bin: { [({ "firebase-tools": "firebase", "npm-check-updates": "ncu", typescript: "tsc" } as Record<string, string>)[name] ?? name]: "bin/cli.js" },
          ...(name === "pnpm" ? { hasInstallScript: true } : {}),
        }])),
      "node_modules/esbuild": {
        version: "0.28.2",
        integrity: "sha512-ZXNi",
        hasInstallScript: true,
      },
      "node_modules/protobufjs": {
        version: "7.6.6",
        integrity: "sha512-cHJvdG8=",
        hasInstallScript: true,
      },
      "node_modules/re2": {
        version: "1.26.1",
        integrity: "sha512-cmUy",
        hasInstallScript: true,
      },
    },
  };
}

async function writePinnedInputs(home: string): Promise<{
  packageJsonPath: string;
  packageLockPath: string;
  packageLockSha256: string;
  groupsPath: string;
  groupsSha256: string;
  bundleSha256: string;
}> {
  const packageJsonPath = path.join(home, "package.json");
  const packageLockPath = path.join(home, "package-lock.json");
  const packageJson = {
    name: "@octogee/builder-toolchain",
    version: "1.0.0",
    private: true,
    dependencies: NPM_PACKAGES,
    allowScripts: {
      "@anthropic-ai/claude-code@2.1.270": true,
      "esbuild@0.28.2": true,
      "pnpm@12.4.1": true,
      "protobufjs@7.6.6": true,
      "re2@1.26.1": true,
    },
  };
  const rawLock = `${JSON.stringify(lockFixture())}\n`;
  const groupsPath = path.join(home, "groups.json");
  const rawGroups = `${JSON.stringify(groupsFixture())}\n`;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson)}\n`);
  await fs.writeFile(packageLockPath, rawLock);
  await fs.writeFile(groupsPath, rawGroups);
  return {
    packageJsonPath,
    packageLockPath,
    packageLockSha256: sha256(rawLock),
    groupsPath,
    groupsSha256: sha256(rawGroups),
    bundleSha256: createHash("sha256").update(rawLock).update(rawGroups).digest("hex"),
  };
}

async function fakeInstall(destination: string): Promise<void> {
  const bin = path.join(destination, "node_modules", ".bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\necho '2.1.270 (Claude Code)'\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.154.0'\n", { mode: 0o755 });
  for (const command of ["firebase", "ncu", "pnpm", "tsc", "tsx"]) {
    await fs.writeFile(path.join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const chromiumPackage = path.join(destination, "node_modules", "@sparticuz", "chromium");
  const chromiumExecutable = path.join(destination, "chromium");
  await fs.mkdir(path.join(chromiumPackage, "build"), { recursive: true });
  await fs.writeFile(
    path.join(chromiumPackage, "package.json"),
    `${JSON.stringify({ type: "module" })}\n`,
  );
  await fs.writeFile(
    path.join(chromiumPackage, "build", "index.js"),
    `export default { executablePath: async () => ${JSON.stringify(chromiumExecutable)} };\n`,
  );
  await fs.writeFile(
    chromiumExecutable,
    "#!/bin/sh\necho 'Chromium 149.0.7827.22'\n",
    { mode: 0o755 },
  );
}

describe("Builder npm toolchain lock", () => {
  it("rejects an enabled command absent from the pinned npm package exports", () => {
    const groups = groupsFixture();
    groups.groups.find((group) => group.id === "web-development")!.commands!.push("tsserver");
    expect(() => parseBuilderToolchainLock(lockFixture(), groups)).toThrow("missing-command:tsserver");
  });

  it("keeps the checked-in npm lock aligned with the enabled npm groups", async () => {
    const [lock, groups] = await Promise.all([
      fs.readFile(path.resolve("..", "infra/gateway/builder-toolchain/package-lock.json"), "utf8"),
      fs.readFile(path.resolve("..", "infra/gateway/builder-toolchain/groups.json"), "utf8"),
    ]);

    expect(() => parseBuilderToolchainLock(
      JSON.parse(lock) as unknown,
      parseBuilderToolGroups(JSON.parse(groups) as unknown),
    )).not.toThrow();
  });

  it("accepts only the exact Builder tool dependencies with registry integrity", () => {
    expect(parseBuilderToolchainLock(lockFixture(), groupsFixture())).toEqual({
      schemaVersion: 1,
      id: "npm-lock-sha256",
      commands: {
        claude: "node_modules/.bin/claude",
        codex: "node_modules/.bin/codex",
        chromium: "node_modules/@sparticuz/chromium/build/index.js",
      },
      versions: { claude: "2.1.270", codex: "0.154.0", chromium: "149.0.0" },
      packages: NPM_PACKAGES,
    });

    const missingIntegrity = lockFixture();
    delete (missingIntegrity.packages as Record<string, Record<string, unknown>>)[
      "node_modules/@openai/codex"
    ].integrity;
    expect(() => parseBuilderToolchainLock(missingIntegrity, groupsFixture()))
      .toThrow(/invalid-toolchain-lock/);
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

    const objectPath = path.join(root, "objects", `sha256-${pin.bundleSha256}`);
    expect(installDependencies).toHaveBeenCalledWith(expect.stringContaining(
      `${path.sep}staging${path.sep}`,
    ), {
      cachePath: path.join(root, "npm-cache"),
      registryUrl: PROXY_REGISTRY,
      authToken: CAPABILITY,
      signal: undefined,
    });
    expect(await fs.readlink(path.join(root, "active"))).toBe(
      `objects/sha256-${pin.bundleSha256}`,
    );
    await expect(resolveToolchainCommand({ root, command: "claude" })).resolves.toMatchObject({
      kind: "ready",
      executable: path.join(await fs.realpath(objectPath), "node_modules", ".bin", "claude"),
    });
    await expect(resolveToolchainCommand({ root, command: "chromium" })).resolves.toMatchObject({
      kind: "ready",
      executable: path.join(
        await fs.realpath(objectPath),
        "node_modules",
        "@sparticuz",
        "chromium",
        "build",
        "index.js",
      ),
    });
    await expect(fs.realpath(path.join(objectPath, "bin", "firebase"))).resolves.toBe(
      path.join(objectPath, "node_modules", ".bin", "firebase"),
    );
    await expect(readToolchainStatus(root)).resolves.toMatchObject({ status: "ready" });
  });

  it("fails hydration when an enabled npm group does not expose its declared command", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: registryCredentials,
      installDependencies: async (destination) => {
        await fakeInstall(destination);
        await fs.rm(path.join(destination, "node_modules", ".bin", "firebase"));
      },
    })).rejects.toMatchObject({ reasonCode: "missing-command:firebase" });
    await expect(readToolchainStatus(root)).resolves.toMatchObject({ status: "failed" });
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

  it.each([
    ["@anthropic-ai/claude-code", "2.1.270"],
    ["pnpm", "12.4.1"],
  ])("requires the exact pinned %s install approval before invoking npm", async (name, version) => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const packageJson = JSON.parse(await fs.readFile(pin.packageJsonPath, "utf8")) as {
      allowScripts: Record<string, boolean>;
    };
    delete packageJson.allowScripts[`${name}@${version}`];
    packageJson.allowScripts[name] = true;
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
        await fakeInstall(destination);
        const bin = path.join(destination, "node_modules", ".bin");
        await fs.writeFile(
          path.join(bin, "claude"),
          "#!/bin/sh\necho 'Error: claude native binary not installed.' >&2\nexit 1\n",
          { mode: 0o755 },
        );
      },
    })).rejects.toMatchObject({ reasonCode: "invalid-command-version" });
    await expect(readToolchainStatus(root)).resolves.toMatchObject({ status: "failed" });
  });

  it("waits for assignment-scoped proxy credentials without invoking direct npm", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const log = vi.fn();
    const installDependencies = vi.fn(fakeInstall);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: async () => { throw new Error("metadata unavailable"); },
      installDependencies,
      log,
    })).rejects.toMatchObject({ reasonCode: "npm-proxy-credentials-unavailable" });

    expect(installDependencies).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[builder-toolchain] npm proxy credentials unavailable; waiting for assignment",
    );
    await expect(readToolchainStatus(root)).resolves.toMatchObject({ status: "pending" });
  });

  it("falls back directly only after an authenticated proxy install fails", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const log = vi.fn();
    const installDependencies = vi.fn(async (
      destination: string,
      options: { registryUrl: string },
    ) => {
      if (options.registryUrl === PROXY_REGISTRY) throw new Error("proxy unavailable");
      await fakeInstall(destination);
    });

    await hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: registryCredentials,
      installDependencies,
      log,
    });

    expect(installDependencies).toHaveBeenCalledTimes(2);
    expect(installDependencies.mock.calls[0]?.[1]).toMatchObject({
      registryUrl: PROXY_REGISTRY,
      authToken: CAPABILITY,
    });
    expect(installDependencies.mock.calls[1]?.[1]).toMatchObject({
      registryUrl: "https://registry.npmjs.org/",
    });
    expect(installDependencies.mock.calls[1]?.[1]).not.toHaveProperty("authToken");
    expect(log).toHaveBeenCalledWith(
      "[builder-toolchain] npm proxy install failed; falling back to direct npm",
    );
  });

  it("rejects an invalid proxy capability without bypassing to direct npm", async () => {
    const home = await tempRoot();
    const root = path.join(home, ".octogee", "toolchains");
    const pin = await writePinnedInputs(home);
    const installDependencies = vi.fn(fakeInstall);

    await expect(hydrateBuilderToolchain({
      root,
      ...pin,
      registryCredentialsProvider: async () => ({
        registryUrl: "https://attacker.example/npm/",
        token: CAPABILITY,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      installDependencies,
    })).rejects.toMatchObject({ reasonCode: "npm-proxy-credentials-unavailable" });

    expect(installDependencies).not.toHaveBeenCalled();
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
