import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVISION_SRC = path.resolve(__dirname, "../mattermost/provision.ts");
const CHANNEL_HOST_SRC = path.resolve(__dirname, "../channel-host/mattermost.ts");
const PROFILE_SYNC_SRC = path.resolve(__dirname, "../mattermost/profile-sync.ts");
const GATEWAY_EDGE_AGENTS_SRC = path.resolve(
  __dirname,
  "../../../gateway-edge/src/routes/agents.ts",
);
const DEFAULT_AGENT_IDENTITY_SRC = path.resolve(
  __dirname,
  "../../../gateway-edge/src/lib/default-agent-identity.ts",
);

describe("coach is a MM bot — creation contract", () => {
  it("provision.ts creates the agent as a bot, not a user", () => {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");

    const defaultAgentIdx = src.indexOf("const defaultAgentUsername = `${slug}-coach`");
    expect(defaultAgentIdx).toBeGreaterThan(-1);

    const botCreateIdx = src.indexOf("host.ensureBot(", defaultAgentIdx);
    expect(botCreateIdx).toBeGreaterThan(defaultAgentIdx);

    const userCreateAfterDefaultAgent = src.indexOf("host.ensureUser(", defaultAgentIdx);
    expect(userCreateAfterDefaultAgent).toBe(-1);
  });

  it("the Mattermost channel host creates bots via POST /bots with display_name", () => {
    const src = fs.readFileSync(CHANNEL_HOST_SRC, "utf-8");
    const ensureBotIdx = src.indexOf("async ensureBot(");
    expect(ensureBotIdx).toBeGreaterThan(-1);
    const block = src.slice(ensureBotIdx, src.indexOf("ensureChannel:", ensureBotIdx));
    expect(block).toMatch(/"POST", "\/bots"/);
    expect(block).toMatch(/display_name:\s*displayName/);
    expect(block).not.toMatch(/first_name:/);
    expect(block).not.toMatch(/nickname:/);
  });

  it("provision.ts passes display_name (not first_name/nickname) on bot create", () => {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");
    const defaultAgentIdx = src.indexOf("const defaultAgentUsername = `${slug}-coach`");
    const blockEnd = src.indexOf("if (!defaultAgentMmUser)", defaultAgentIdx);
    const block = src.slice(defaultAgentIdx, blockEnd);
    expect(block).toMatch(/displayName:\s*"Octo"/);
    expect(block).not.toMatch(/firstName:/);
    expect(block).not.toMatch(/nickname:/);
  });
});

describe("coach is a MM bot — rename contract", () => {
  it("gateway-edge PATCH /me delegates agent writes to the shared identity core", () => {
    const src = fs.readFileSync(GATEWAY_EDGE_AGENTS_SRC, "utf-8");
    expect(src).toMatch(/import\s+\{\s*syncDefaultAgentIdentity\s*\}/);
    expect(src).toMatch(/await\s+syncDefaultAgentIdentity\(uid,\s*patch\)/);
  });

  it("shared agent identity sync uses PUT /bots/{id} with display_name", () => {
    const src = fs.readFileSync(DEFAULT_AGENT_IDENTITY_SRC, "utf-8");
    expect(src).toMatch(/`\/bots\/\$\{defaultAgentMmUserId\}`,\s*"PUT"/);
    expect(src).toMatch(/display_name:\s*patch\.name/);
    expect(src).not.toMatch(/\/users\/\$\{defaultAgentMmUserId\}\/patch/);
  });

  it("profile-sync.ts uses PUT /bots/{id} with display_name", () => {
    const src = fs.readFileSync(PROFILE_SYNC_SRC, "utf-8");
    expect(src).toMatch(/`\/bots\/\$\{defaultAgentMmUserId\}`/);
    expect(src).toMatch(/display_name:\s*defaultAgentName/);
    expect(src).not.toMatch(/\/users\/\$\{defaultAgentMmUserId\}\/patch/);
  });
});
