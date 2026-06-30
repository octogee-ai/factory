import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const h = vi.hoisted(() => ({
  customersDir: "",
  log: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
  get CUSTOMERS_DIR() {
    return h.customersDir;
  },
  log: h.log,
}));

const { cleanupStaleLimitsMd } = await import("../lib/migrations.js");

describe("cleanupStaleLimitsMd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "limits-migration-"));
    h.customersDir = path.join(tmpDir, "customers");
    h.log.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op when the customers directory does not exist", () => {
    cleanupStaleLimitsMd();

    expect(h.log).not.toHaveBeenCalled();
  });

  it("removes stale coach LIMITS.md files and leaves other files in place", () => {
    const aliceCoach = path.join(h.customersDir, "alice", "coach");
    const bobCoach = path.join(h.customersDir, "bob", "coach");
    fs.mkdirSync(aliceCoach, { recursive: true });
    fs.mkdirSync(bobCoach, { recursive: true });
    fs.writeFileSync(path.join(aliceCoach, "LIMITS.md"), "old");
    fs.writeFileSync(path.join(aliceCoach, "README.md"), "keep");

    cleanupStaleLimitsMd();

    expect(fs.existsSync(path.join(aliceCoach, "LIMITS.md"))).toBe(false);
    expect(fs.existsSync(path.join(aliceCoach, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(bobCoach, "LIMITS.md"))).toBe(false);
    expect(h.log).toHaveBeenCalledWith("throttle: removed stale LIMITS.md for alice");
  });
});
