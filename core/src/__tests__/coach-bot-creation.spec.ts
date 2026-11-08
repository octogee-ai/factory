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
const COACH_IDENTITY_SRC = path.resolve(
  __dirname,
  "../../../gateway-edge/src/lib/coach-identity.ts",
);

describe("coach is a MM bot — creation contract", () => {
  it("provision.ts creates the coach as a bot, not a user", () => {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");

    const coachIdx = src.indexOf("const coachUsername = `${slug}-coach`");
    expect(coachIdx).toBeGreaterThan(-1);

    const botCreateIdx = src.indexOf("host.ensureBot(", coachIdx);
    expect(botCreateIdx).toBeGreaterThan(coachIdx);

    const userCreateAfterCoach = src.indexOf("host.ensureUser(", coachIdx);
    expect(userCreateAfterCoach).toBe(-1);
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
    const coachIdx = src.indexOf("const coachUsername = `${slug}-coach`");
    const blockEnd = src.indexOf("if (!coachMmUser)", coachIdx);
    const block = src.slice(coachIdx, blockEnd);
    expect(block).toMatch(/displayName:\s*"Octo"/);
    expect(block).not.toMatch(/firstName:/);
    expect(block).not.toMatch(/nickname:/);
  });
});

describe("coach is a MM bot — rename contract", () => {
  it("gateway-edge PATCH /me delegates coach writes to the shared identity core", () => {
    const src = fs.readFileSync(GATEWAY_EDGE_AGENTS_SRC, "utf-8");
    expect(src).toMatch(/import\s+\{\s*syncCoachIdentity\s*\}/);
    expect(src).toMatch(/await\s+syncCoachIdentity\(uid,\s*patch\)/);
  });

  it("shared coach identity sync uses PUT /bots/{id} with display_name", () => {
    const src = fs.readFileSync(COACH_IDENTITY_SRC, "utf-8");
    expect(src).toMatch(/`\/bots\/\$\{coachMmUserId\}`,\s*"PUT"/);
    expect(src).toMatch(/display_name:\s*patch\.name/);
    expect(src).not.toMatch(/\/users\/\$\{coachMmUserId\}\/patch/);
  });

  it("profile-sync.ts uses PUT /bots/{id} with display_name", () => {
    const src = fs.readFileSync(PROFILE_SYNC_SRC, "utf-8");
    expect(src).toMatch(/`\/bots\/\$\{coachMmUserId\}`/);
    expect(src).toMatch(/display_name:\s*coachName/);
    expect(src).not.toMatch(/\/users\/\$\{coachMmUserId\}\/patch/);
  });
});
