import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGiteaUser,
  generateCustomerSshKey,
  gitExec,
  setRepoSshCommand,
} from "../lib/git.js";
import {
  ensureGiteaOrgForWorkspace,
  ensureSystemConfigRepo,
} from "../lib/gitea-admin-broker-client.js";
import {
  pushDirtySystemConfigForSlug,
  removeLegacyMacConfig,
  removeLegacyMacState,
  restoreSystemConfigForSlug,
  syncSystemConfigForSlug,
  systemConfigPath,
  systemConfigDir,
} from "../lib/system-config.js";
import { systemConfigFingerprint } from "../lib/system-config-watcher.js";
import { validateOpenClawConfig } from "../lib/openclaw-config-validation.js";

vi.mock("../lib/git.js", () => ({
  createGiteaUser: vi.fn(async () => {}),
  customerSshKeyPath: vi.fn((slug: string) => `/tmp/customer-keys/${slug}/id_ed25519`),
  generateCustomerSshKey: vi.fn(() => "ssh-ed25519 AAA octogee-acme@gateway"),
  gitExec: vi.fn(() => "ok"),
  setRepoSshCommand: vi.fn(),
}));

vi.mock("../lib/gitea-admin-broker-client.js", () => ({
  ensureGiteaOrgForWorkspace: vi.fn(async () => {}),
  ensureSystemConfigRepo: vi.fn(async () => {}),
}));

vi.mock("../lib/openclaw-config-validation.js", () => ({
  validateOpenClawConfig: vi.fn(),
}));

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("system_config restore", () => {
  let dir: string;
  let openclawDir: string;
  let repoDir: string;
  let templatePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-system-config-"));
    openclawDir = path.join(dir, ".openclaw");
    repoDir = systemConfigDir(openclawDir);
    templatePath = path.join(dir, "openclaw.template.json");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips invalid builder slugs before touching brokered Gitea", async () => {
    const result = await restoreSystemConfigForSlug("../bad", {
      openclawDir,
      templatePath,
      log: () => {},
    });

    expect(result).toEqual({ skipped: "invalid-builder-slug", seeded: false, restored: false });
    expect(generateCustomerSshKey).not.toHaveBeenCalled();
    expect(ensureSystemConfigRepo).not.toHaveBeenCalled();
  });

  it("seeds a missing repo config from the safe template without resolving secrets", async () => {
    fs.writeFileSync(
      templatePath,
      JSON.stringify({
        agents: { list: [] },
        channels: {
          mattermost: {
            baseUrl: "${MM_URL}",
            accounts: {},
          },
        },
      }),
      "utf-8",
    );

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: {
        GATEWAY_ID: "bender-green",
        GATEWAY_BUILDER_SLUG: "bender",
        MM_URL: "http://mm",
      },
      log: () => {},
    });

    expect(result).toEqual({
      seeded: true,
      restored: true,
      configPath: path.join(repoDir, "openclaw.json"),
    });
    expect(createGiteaUser).toHaveBeenCalledWith("acme", "ssh-ed25519 AAA octogee-acme@gateway");
    expect(ensureGiteaOrgForWorkspace).toHaveBeenCalledWith("acme");
    expect(ensureSystemConfigRepo).toHaveBeenCalledWith("acme");
    expect(setRepoSshCommand).toHaveBeenCalledWith(repoDir, "acme");
    expect(gitExec).toHaveBeenCalledWith(repoDir, "add openclaw.json .octogee.json .gitignore");
    expect(gitExec).toHaveBeenCalledWith(
      repoDir,
      "commit -m \"initial system_config openclaw template\"",
    );
    const tracked = fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8");
    expect(tracked).toContain("${MM_URL}");
    expect(tracked).not.toContain("Mac");
    expect(tracked).not.toContain("botToken");
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf-8"))).toEqual({
      schemaVersion: 1,
      lastMigration: "initial",
    });
    expect(fs.readFileSync(path.join(repoDir, ".gitignore"), "utf-8")).toContain("*.tmp");
  });

  it("does not report a seeded durable config until its initial commit is pushed", async () => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(templatePath, "{\"agents\":{\"list\":[]}}\n");
    vi.mocked(gitExec).mockImplementation((_cwd: string, args: string) =>
      args === "push -u origin main" ? null : "ok"
    );

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).rejects.toThrow(/initial push failed/);
  });

  it("fast-forwards a reused checkout before reading its authoritative config", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: 1 });

    await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    });

    expect(gitExec).toHaveBeenCalledWith(repoDir, "fetch origin main", "/tmp/customer-keys/acme/id_ed25519");
    expect(gitExec).toHaveBeenCalledWith(repoDir, "merge --ff-only origin/main", "/tmp/customer-keys/acme/id_ed25519");
  });

  it("one-time cleanup removes only the historical Mac lane and preserves customer identities", () => {
    const config = {
      agents: {
        list: [
          {
            id: "octogee-ops-${GATEWAY_ID}",
            name: "Mac (${GATEWAY_ID})",
            workspace: "/home/node/.openclaw/workspace/ops",
            agentDir: "/home/node/.openclaw/agents/octogee-ops-${GATEWAY_ID}/agent",
          },
          {
            id: "octogee-ceckert-coach",
            name: "BenderEcho (ceckert)",
            workspace: "/home/node/.openclaw/customers/ceckert",
          },
        ],
      },
      bindings: [
        { agentId: "octogee-ops-${GATEWAY_ID}", match: { channel: "mattermost" } },
        { agentId: "octogee-ceckert-coach", match: { channel: "mattermost" } },
      ],
      channels: {
        mattermost: {
          defaultAccount: "default",
          accounts: {
            default: { botToken: "legacy-mac-pat" },
            "ceckert-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/ceckert-coach" } },
          },
        },
      },
    };

    expect(removeLegacyMacConfig(config, { GATEWAY_ID: "bender", GATEWAY_BUILDER_SLUG: "ceckert" })).toBe(true);
    expect(config.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-ceckert-coach", default: true }),
    ]);
    expect(config.bindings).toEqual([
      expect.objectContaining({ agentId: "octogee-ceckert-coach" }),
    ]);
    expect(config.channels.mattermost.accounts).toEqual({
      "ceckert-coach": expect.any(Object),
    });
    expect(config.channels.mattermost).not.toHaveProperty("defaultAccount");
  });

  it("preserves a customer-owned default Mattermost account when no historical Mac lane exists", () => {
    const config = {
      agents: {
        list: [
          {
            id: "octogee-ceckert-coach",
            name: "BenderEcho (ceckert)",
            workspace: "/home/node/.openclaw/customers/ceckert",
          },
        ],
      },
      bindings: [
        {
          agentId: "octogee-ceckert-coach",
          match: { channel: "mattermost", accountId: "default" },
        },
      ],
      channels: {
        mattermost: {
          defaultAccount: "default",
          accounts: {
            default: {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/default",
              },
            },
          },
        },
      },
    };

    expect(removeLegacyMacConfig(config, {
      GATEWAY_ID: "bender",
      GATEWAY_BUILDER_SLUG: "ceckert",
    })).toBe(true);
    expect(config.channels.mattermost.accounts.default).toBeDefined();
    expect(config.channels.mattermost.defaultAccount).toBe("default");
    expect(config.bindings).toEqual([
      expect.objectContaining({ agentId: "octogee-ceckert-coach" }),
    ]);
  });

  it("one-time state cleanup deletes only exact Mac directories and memory files", () => {
    const removedAgentDir = path.join(openclawDir, "agents", "octogee-ops-ceckert");
    const keptAgentDir = path.join(openclawDir, "agents", "octogee-ceckert-coach");
    fs.mkdirSync(removedAgentDir, { recursive: true });
    fs.mkdirSync(keptAgentDir, { recursive: true });
    fs.mkdirSync(path.join(openclawDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "memory", "octogee-ops-ceckert.sqlite"), "legacy");
    fs.writeFileSync(path.join(openclawDir, "memory", "octogee-ceckert-coach.sqlite"), "customer");

    removeLegacyMacState(openclawDir, { GATEWAY_ID: "bender", GATEWAY_BUILDER_SLUG: "ceckert" });

    expect(fs.existsSync(removedAgentDir)).toBe(false);
    expect(fs.existsSync(path.join(openclawDir, "memory", "octogee-ops-ceckert.sqlite"))).toBe(false);
    expect(fs.existsSync(keptAgentDir)).toBe(true);
    expect(fs.existsSync(path.join(openclawDir, "memory", "octogee-ceckert-coach.sqlite"))).toBe(true);
  });

  it("restores an existing repo config without reseeding", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      channels: { mattermost: { baseUrl: "${MM_URL}", accounts: { default: {} } } },
    });

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: { MM_URL: "http://mm2" },
      log: () => {},
    });

    expect(result).toEqual({
      seeded: false,
      restored: true,
      configPath: path.join(repoDir, "openclaw.json"),
    });
    expect(gitExec).not.toHaveBeenCalledWith(repoDir, "add openclaw.json .octogee.json .gitignore");
    const tracked = fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8");
    expect(tracked).toContain("${MM_URL}");
    expect(tracked).not.toContain("http://mm2");
  });

  it("leaves an invalid checked-out head for accepted-ancestor recovery instead of blocking restore", async () => {
    fs.writeFileSync(path.join(repoDir, "openclaw.json"), "{ invalid\n", "utf8");
    writeJson(path.join(repoDir, ".octogee.json"), { schemaVersion: 1 });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).resolves.toMatchObject({ restored: true, configPath: path.join(repoDir, "openclaw.json") });
    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8")).toBe("{ invalid\n");
  });

  it("adopts legacy customer Mattermost tokens into the untracked file provider", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      channels: {
        mattermost: {
          accounts: {
            "acme-coach": { botToken: "legacy-coach-pat", groupPolicy: "open" },
          },
        },
      },
    });

    await restoreSystemConfigForSlug("acme", { openclawDir, templatePath, log: () => {} });

    const tracked = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(tracked.channels.mattermost.accounts["acme-coach"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/acme-coach",
    });
    expect(JSON.parse(fs.readFileSync(path.join(openclawDir, "secrets", "mattermost-accounts.json"), "utf8"))).toEqual({
      "acme-coach": "legacy-coach-pat",
    });
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      lastMigration: "remove-mac-and-externalize-mattermost-tokens",
    });
  });

  it("makes the isolated Builder coach default even when no Mac agent remains", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: {
        list: [{ id: "octogee-acme-coach" }],
      },
      channels: {
        mattermost: {
          accounts: { default: {} },
          defaultAccount: "default",
        },
      },
    });

    await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: { GATEWAY_BUILDER_SLUG: "acme" },
      log: () => {},
    });

    const tracked = JSON.parse(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8"));
    expect(tracked.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-acme-coach", default: true }),
    ]);
    expect(tracked.channels.mattermost.accounts).toEqual({});
    expect(tracked.channels.mattermost).not.toHaveProperty("defaultAccount");
  });

  it("does not silently adopt plaintext tokens after the one-time migration", async () => {
    writeJson(path.join(repoDir, ".octogee.json"), {
      schemaVersion: 1,
      lastMigration: "remove-mac-and-externalize-mattermost-tokens",
    });
    writeJson(path.join(repoDir, "openclaw.json"), {
      channels: {
        mattermost: {
          accounts: {
            "acme-coach": { botToken: "must-be-rejected-by-audit" },
          },
        },
      },
    });

    await restoreSystemConfigForSlug("acme", { openclawDir, templatePath, log: () => {} });

    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf8")).toContain(
      "must-be-rejected-by-audit",
    );
    expect(fs.existsSync(path.join(openclawDir, "secrets", "mattermost-accounts.json"))).toBe(false);
  });

  it("fails closed when tracked migration metadata is malformed", async () => {
    fs.writeFileSync(path.join(repoDir, ".octogee.json"), "{ invalid", "utf-8");
    writeJson(path.join(repoDir, "openclaw.json"), {
      agents: { list: [{ id: "octogee-acme-coach" }] },
    });

    await expect(restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      log: () => {},
    })).rejects.toThrow(/invalid system_config metadata/);

    expect(fs.readFileSync(path.join(repoDir, ".octogee.json"), "utf-8")).toBe("{ invalid");
    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8")).toContain(
      "octogee-acme-coach",
    );
  });

  it("uses the tracked repository file as the active config without expanding secrets", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      channels: {
        mattermost: {
          baseUrl: "${MM_URL}",
          accounts: { default: { botToken: "${MM_BOT_TOKEN}" } },
        },
      },
    });

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      templatePath,
      env: { MM_URL: "http://mm", MM_BOT_TOKEN: "must-not-enter-git" },
      log: () => {},
    });

    expect(result).toMatchObject({ restored: true, configPath: systemConfigPath(openclawDir) });
    const tracked = fs.readFileSync(systemConfigPath(openclawDir), "utf-8");
    expect(JSON.parse(tracked).channels.mattermost.accounts).toEqual({});
    expect(tracked).not.toContain("${MM_BOT_TOKEN}");
    expect(tracked).not.toContain("must-not-enter-git");
    expect(fs.existsSync(path.join(openclawDir, "openclaw.json"))).toBe(false);
  });

  it("preStop sync commits and pushes only dirty system_config openclaw.json", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const calls: Array<{ cwd: string; args: string; sshKeyPath?: string }> = [];
    const logs: string[] = [];
    const result = pushDirtySystemConfigForSlug("acme", {
      openclawDir,
      now: () => new Date("2026-06-20T14:00:00.000Z"),
      log: (msg) => logs.push(msg),
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: vi.fn((cwd: string, args: string, sshKeyPath?: string) => {
        calls.push({ cwd, args, sshKeyPath });
        if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
        return "ok";
      }),
    });

    expect(result).toEqual({ committed: true, pushed: true });
    expect(calls.map((call) => call.args)).toEqual([
      "status --porcelain -- openclaw.json .octogee.json .gitignore",
      "add openclaw.json .octogee.json .gitignore",
      expect.stringContaining("Octogee-Config-Source: auto-watch"),
      "push origin main",
      "rev-parse HEAD",
    ]);
    expect(logs.join("\n")).toMatch(/auto-watch pushed/);
    expect(validateOpenClawConfig).toHaveBeenCalledWith(path.join(repoDir, "openclaw.json"));
  });

  it("preStop sync skips a clean system_config checkout", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const git = vi.fn((cwd: string, args: string) => {
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return "";
      return "unexpected";
    });

    const result = pushDirtySystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toEqual({ committed: false, pushed: false });
    expect(git).toHaveBeenCalledTimes(1);
  });

  it("preStop sync treats git status failure as skipped, not clean", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const logs: string[] = [];

    const result = pushDirtySystemConfigForSlug("acme", {
      openclawDir,
      log: (msg) => logs.push(msg),
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: vi.fn(() => null),
    });

    expect(result).toEqual({ skipped: "status-failed", committed: false, pushed: false });
    expect(logs.join("\n")).toMatch(/status check failed/);
  });

  it("watcher sync retries a previously committed change even when the worktree is clean", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const git = vi.fn((_cwd: string, args: string) => {
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return "";
      if (args === "push origin main") return "ok";
      return null;
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ committed: false, pushed: true, pending: false });
    expect(git).toHaveBeenCalledWith(repoDir, "push origin main", "/tmp/key");
  });

  it("watcher sync marks a local commit pending when push fails", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { agents: { list: [] } });
    const git = vi.fn((_cwd: string, args: string) => {
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args === "push origin main") return null;
      return "ok";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ committed: true, pushed: false, pending: true });
  });

  it("reports the staged fingerprint so an edit racing the commit receives another pass", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    const stagedFingerprint = systemConfigFingerprint(configPath);
    const git = vi.fn((_cwd: string, args: string) => {
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args.startsWith("commit -m ")) {
        writeJson(configPath, { version: 2 });
      }
      return "ok";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result.processedFingerprint).toBe(stagedFingerprint);
    expect(systemConfigFingerprint(configPath)).not.toBe(result.processedFingerprint);
  });

  it("backs off and retries a transient staging failure instead of spinning", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    const git = vi.fn((_cwd: string, args: string) =>
      args === "status --porcelain -- openclaw.json .octogee.json .gitignore" ? " M openclaw.json" : null
    );

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({
      skipped: "stage-failed",
      pending: true,
      processedFingerprint: systemConfigFingerprint(configPath),
    });
  });

  it("defers when another config-sync process owns the gateway lock", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);
    const git = vi.fn(() => "unexpected");

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({
      skipped: "sync-locked",
      pending: true,
      processedFingerprint: systemConfigFingerprint(configPath),
    });
    expect(git).not.toHaveBeenCalled();
  });

  it("uses an already-held writer lock without racing itself", () => {
    const configPath = path.join(repoDir, "openclaw.json");
    writeJson(configPath, { version: 1 });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);
    const git = vi.fn((_cwd: string, args: string) => {
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args === "rev-parse HEAD") return "a".repeat(40);
      return "ok";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      lockHeld: true,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ pushed: true, acceptedCommit: "a".repeat(40) });
    expect(fs.existsSync(path.join(openclawDir, "system_config.sync.lock"))).toBe(true);
  });

  it("reclaims a stale incomplete config-sync lock after a crashed writer", () => {
    writeJson(path.join(repoDir, "openclaw.json"), { version: 1 });
    const lockPath = path.join(openclawDir, "system_config.sync.lock");
    fs.writeFileSync(lockPath, "");
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    const git = vi.fn((_cwd: string, args: string) =>
      args === "status --porcelain -- openclaw.json .octogee.json .gitignore" ? "" : "ok"
    );

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({ pushed: true, pending: false });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects and restores a config that fails validation before staging", () => {
    fs.writeFileSync(path.join(repoDir, "openclaw.json"), "{ invalid", "utf-8");
    const git = vi.fn((_cwd: string, args: string) => {
      if (args === "status --porcelain -- openclaw.json .octogee.json .gitignore") return " M openclaw.json";
      if (args === "show HEAD:openclaw.json") return "{\"accepted\":true}\n";
      return "unexpected";
    });

    const result = syncSystemConfigForSlug("acme", {
      openclawDir,
      now: () => new Date("2026-07-14T17:00:00.000Z"),
      validateConfig: () => {
        throw new Error("config invalid");
      },
      log: () => {},
      setRepoSshCommand: vi.fn(),
      customerSshKeyPath: () => "/tmp/key",
      gitExec: git,
    });

    expect(result).toMatchObject({
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: "validation-failed",
    });
    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8")).toBe(
      "{\"accepted\":true}\n",
    );
    const rejected = path.join(
      openclawDir,
      "rejected_config",
      "openclaw.2026-07-14T17-00-00-000Z.json",
    );
    expect(fs.readFileSync(rejected, "utf-8")).toBe("{ invalid");
    expect(fs.statSync(rejected).mode & 0o777).toBe(0o600);
    expect(git).not.toHaveBeenCalledWith(repoDir, "add openclaw.json .octogee.json .gitignore", "/tmp/key");
  });
});
