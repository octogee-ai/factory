import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportActivationManifestWithSecret,
  materializeActivationManifestSecret,
} from "../lib/migration-activation-secrets.js";
import { updateMattermostAccountSecrets } from "../lib/mattermost-account-secrets.js";

const dirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-activation-secret-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("migration activation Mattermost secrets", () => {
  it("exports a transient manifest with the token resolved outside tracked config", async () => {
    const openclawDir = await tmp();
    const configPath = path.join(openclawDir, "system_config", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      agents: {
        list: [
          { id: "octogee-alice-coach" },
          { id: "octogee-alice-proj-orbit-coach" },
          { id: "octogee-bob-coach" },
        ],
      },
      channels: { mattermost: { accounts: {
        "alice-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" } },
        "alice-proj-orbit": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-proj-orbit" } },
        "bob-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/bob-coach" } },
      } } },
      bindings: [
        { agentId: "octogee-alice-coach" },
        { agentId: "octogee-alice-proj-orbit-coach" },
        { agentId: "octogee-bob-coach" },
      ],
    }));
    await updateMattermostAccountSecrets(openclawDir, {
      set: { "alice-coach": "coach-pat", "alice-proj-orbit": "orbit-pat" },
    });

    const manifest = await exportActivationManifestWithSecret(configPath, openclawDir, "alice");

    expect(manifest.mattermostAccount.botToken).toBe("coach-pat");
    expect(manifest.projectAgents).toMatchObject([
      {
        agentId: "octogee-alice-proj-orbit-coach",
        accountId: "alice-proj-orbit",
        mattermostAccount: { botToken: "orbit-pat" },
      },
    ]);
    expect(await fs.readFile(configPath, "utf8")).not.toContain("coach-pat");
    expect(await fs.readFile(configPath, "utf8")).not.toContain("orbit-pat");
  });

  it("writes the transferred token locally and applies only a SecretRef", async () => {
    const openclawDir = await tmp();
    await updateMattermostAccountSecrets(openclawDir, {
      set: { "alice-proj-retired": "retired-pat", "bob-proj-orbit": "foreign-pat" },
    });
    const manifest = {
      version: 1 as const,
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      agent: { id: "octogee-alice-coach" },
      mattermostAccount: { botToken: "coach-pat", groupPolicy: "open" },
      bindings: [{ agentId: "octogee-alice-coach" }],
      projectAgents: [
        {
          agentId: "octogee-alice-proj-orbit-coach",
          accountId: "alice-proj-orbit",
          agent: { id: "octogee-alice-proj-orbit-coach" },
          mattermostAccount: { botToken: "orbit-pat", groupPolicy: "open" },
          bindings: [{ agentId: "octogee-alice-proj-orbit-coach" }],
        },
      ],
    };

    const safe = await materializeActivationManifestSecret(openclawDir, manifest);

    expect(safe.mattermostAccount.botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/alice-coach",
    });
    expect(safe.projectAgents[0]?.mattermostAccount.botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/alice-proj-orbit",
    });
    expect(JSON.parse(await fs.readFile(path.join(openclawDir, "secrets", "mattermost-accounts.json"), "utf8"))).toEqual({
      "alice-coach": "coach-pat",
      "alice-proj-orbit": "orbit-pat",
      "bob-proj-orbit": "foreign-pat",
    });
  });
});
