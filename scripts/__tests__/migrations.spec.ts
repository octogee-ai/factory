import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const h = vi.hoisted(() => ({
  usersDir: "",
  log: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
  get CUSTOMERS_DIR() {
    return h.usersDir;
  },
  log: h.log,
}));

const { cleanupStaleLimitsMd } = await import("../lib/migrations.js");

describe("cleanupStaleLimitsMd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "limits-migration-"));
    h.usersDir = path.join(tmpDir, "customers");
    h.log.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op when the users directory does not exist", () => {
    cleanupStaleLimitsMd();

    expect(h.log).not.toHaveBeenCalled();
  });

  it("removes stale agent LIMITS.md files and leaves other files in place", () => {
    const aliceDefaultAgent = path.join(h.usersDir, "alice", "coach");
    const bobDefaultAgent = path.join(h.usersDir, "bob", "coach");
    fs.mkdirSync(aliceDefaultAgent, { recursive: true });
    fs.mkdirSync(bobDefaultAgent, { recursive: true });
    fs.writeFileSync(path.join(aliceDefaultAgent, "LIMITS.md"), "old");
    fs.writeFileSync(path.join(aliceDefaultAgent, "README.md"), "keep");

    cleanupStaleLimitsMd();

    expect(fs.existsSync(path.join(aliceDefaultAgent, "LIMITS.md"))).toBe(false);
    expect(fs.existsSync(path.join(aliceDefaultAgent, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(bobDefaultAgent, "LIMITS.md"))).toBe(false);
    expect(h.log).toHaveBeenCalledWith("throttle: removed stale LIMITS.md for alice");
  });
});
