import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVISION_SRC = path.resolve(__dirname, "../lib/mattermost/provision.ts");
const PROFILE_SYNC_SRC = path.resolve(__dirname, "../lib/mattermost/profile-sync.ts");
const MILESTONES_SRC = path.resolve(__dirname, "../lib/milestones.ts");
const GATEWAY_EDGE_AGENTS_SRC = path.resolve(
  __dirname,
  "../../gateway-edge/src/routes/agents.ts",
);

describe("coach is a MM bot — creation contract", () => {
  it("provision.ts creates the coach via POST /bots, not POST /users", () => {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");
    // The Builder's own MM user is still POST /users — that's correct, the
    // Builder is a person. Find the coach-creation block and assert it uses
    // /bots. Look for the coachUsername line and a POST /bots call near it.
    const coachIdx = src.indexOf("const coachUsername = `${slug}-coach`");
    expect(coachIdx).toBeGreaterThan(-1);

    // The coach create call must be `POST /bots` and must appear after the
    // coachUsername declaration.
    const botCreateIdx = src.indexOf('mmApiCall("POST", "/bots"', coachIdx);
    expect(botCreateIdx).toBeGreaterThan(coachIdx);

    // And the coach block must NOT use POST /users (regression guard).
    const userCreateAfterCoach = src.indexOf('mmApiCall("POST", "/users"', coachIdx);
    expect(userCreateAfterCoach).toBe(-1);
  });

  it("provision.ts passes display_name (not first_name/nickname) on bot create", () => {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");
    const coachIdx = src.indexOf("const coachUsername = `${slug}-coach`");
    const blockEnd = src.indexOf("if (!coachMmUser)", coachIdx);
    const block = src.slice(coachIdx, blockEnd);
    expect(block).toMatch(/display_name:\s*"Octo"/);
    expect(block).not.toMatch(/first_name:/);
    expect(block).not.toMatch(/nickname:/);
  });
});

describe("coach is a MM bot — rename contract", () => {
  it("gateway-edge PATCH /me uses PUT /bots/{id} with display_name", () => {
    const src = fs.readFileSync(GATEWAY_EDGE_AGENTS_SRC, "utf-8");
    expect(src).toMatch(/`\/bots\/\$\{coachMmUserId\}`,\s*"PUT"/);
    expect(src).toMatch(/display_name:\s*patch\.name/);
    // Regression guard: the old user-patch path is gone.
    expect(src).not.toMatch(/\/users\/\$\{coachMmUserId\}\/patch/);
  });

  it("milestones.ts uses PUT /bots/{id} with display_name", () => {
    const src = fs.readFileSync(MILESTONES_SRC, "utf-8");
    expect(src).toMatch(/`\/bots\/\$\{coachMmUserId\}`/);
    expect(src).toMatch(/display_name:\s*milestones\.coachName/);
    expect(src).not.toMatch(/\/users\/\$\{coachMmUserId\}\/patch/);
  });

  it("profile-sync.ts uses PUT /bots/{id} with display_name", () => {
    const src = fs.readFileSync(PROFILE_SYNC_SRC, "utf-8");
    expect(src).toMatch(/`\/bots\/\$\{coachMmUserId\}`/);
    expect(src).toMatch(/display_name:\s*coachName/);
    expect(src).not.toMatch(/\/users\/\$\{coachMmUserId\}\/patch/);
  });
});
