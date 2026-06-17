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
  expandEnvPlaceholders,
  restoreSystemConfigForSlug,
  systemConfigDir,
} from "../lib/system-config.js";

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

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("system_config restore", () => {
  let dir: string;
  let openclawDir: string;
  let repoDir: string;
  let runtimeConfigPath: string;
  let templatePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-system-config-"));
    openclawDir = path.join(dir, ".openclaw");
    repoDir = systemConfigDir(openclawDir);
    runtimeConfigPath = path.join(openclawDir, "openclaw.json");
    templatePath = path.join(dir, "openclaw.template.json");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("expands envsubst-style placeholders", () => {
    expect(expandEnvPlaceholders("url=${MM_URL} missing=${NOPE}", { MM_URL: "http://mm" })).toBe(
      "url=http://mm missing=",
    );
  });

  it("skips invalid builder slugs before touching brokered Gitea", async () => {
    const result = await restoreSystemConfigForSlug("../bad", {
      openclawDir,
      runtimeConfigPath,
      templatePath,
      log: () => {},
    });

    expect(result).toEqual({ skipped: "invalid-builder-slug", seeded: false, restored: false });
    expect(generateCustomerSshKey).not.toHaveBeenCalled();
    expect(ensureSystemConfigRepo).not.toHaveBeenCalled();
  });

  it("seeds a missing repo config from the safe template and preserves the minted Mac bot token", async () => {
    writeJson(runtimeConfigPath, {
      channels: { mattermost: { accounts: { default: { botToken: "minted-mac-pat" } } } },
    });
    fs.writeFileSync(
      templatePath,
      JSON.stringify({
        agents: { list: [{ id: "octogee-ops-${GATEWAY_ID}" }] },
        channels: {
          mattermost: {
            baseUrl: "${MM_URL}",
            accounts: { default: { botToken: "${MM_BOT_TOKEN}" } },
          },
        },
      }),
      "utf-8",
    );

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      runtimeConfigPath,
      templatePath,
      env: { GATEWAY_ID: "bender", MM_URL: "http://mm", MM_BOT_TOKEN: "" },
      log: () => {},
    });

    expect(result).toEqual({ seeded: true, restored: true });
    expect(createGiteaUser).toHaveBeenCalledWith("acme", "ssh-ed25519 AAA octogee-acme@gateway");
    expect(ensureGiteaOrgForWorkspace).toHaveBeenCalledWith("acme");
    expect(ensureSystemConfigRepo).toHaveBeenCalledWith("acme");
    expect(setRepoSshCommand).toHaveBeenCalledWith(repoDir, "acme");
    expect(gitExec).toHaveBeenCalledWith(repoDir, "add openclaw.json");
    expect(gitExec).toHaveBeenCalledWith(
      repoDir,
      "commit -m \"initial system_config openclaw template\"",
    );
    expect(fs.readFileSync(path.join(repoDir, "openclaw.json"), "utf-8")).toContain("${GATEWAY_ID}");

    const runtime = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf-8"));
    expect(runtime.agents.list[0].id).toBe("octogee-ops-bender");
    expect(runtime.channels.mattermost.baseUrl).toBe("http://mm");
    expect(runtime.channels.mattermost.accounts.default.botToken).toBe("minted-mac-pat");
  });

  it("restores an existing repo config without reseeding", async () => {
    writeJson(path.join(repoDir, "openclaw.json"), {
      channels: { mattermost: { baseUrl: "${MM_URL}", accounts: { default: {} } } },
    });

    const result = await restoreSystemConfigForSlug("acme", {
      openclawDir,
      runtimeConfigPath,
      templatePath,
      env: { MM_URL: "http://mm2" },
      log: () => {},
    });

    expect(result).toEqual({ seeded: false, restored: true });
    expect(gitExec).not.toHaveBeenCalledWith(repoDir, "add openclaw.json");
    const runtime = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf-8"));
    expect(runtime.channels.mattermost.baseUrl).toBe("http://mm2");
  });
});
