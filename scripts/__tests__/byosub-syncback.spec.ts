import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fingerprintFile,
  decideSyncBack,
  syncBackSweep,
  type AuthFingerprint,
} from "../lib/byosub-syncback.js";

const tmp: string[] = [];
function mkfile(content: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sb-"));
  tmp.push(d);
  const f = path.join(d, "auth.json");
  fs.writeFileSync(f, content);
  return f;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("fingerprintFile", () => {
  it("returns sha256 + size for an existing file", () => {
    const fp = fingerprintFile(mkfile('{"tokens":{"refresh_token":"a"}}'));
    expect(fp).not.toBeNull();
    expect(fp!.size).toBeGreaterThan(0);
    expect(fp!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is content-stable and content-sensitive", () => {
    const a = fingerprintFile(mkfile('{"x":1}'));
    const b = fingerprintFile(mkfile('{"x":1}'));
    const c = fingerprintFile(mkfile('{"x":2}'));
    expect(a!.sha256).toBe(b!.sha256);
    expect(a!.sha256).not.toBe(c!.sha256);
  });

  it("returns null for a missing/unreadable file (no throw)", () => {
    expect(fingerprintFile("/no/such/path/auth.json")).toBeNull();
  });
});

describe("decideSyncBack", () => {
  const fp = (s: string): AuthFingerprint => ({ sha256: s, size: 1 });

  it("first observation (no prior) is a change", () => {
    const d = decideSyncBack(null, fp("aaa"));
    expect(d.changed).toBe(true);
  });

  it("a content change (token rotation) is a change", () => {
    expect(decideSyncBack(fp("aaa"), fp("bbb")).changed).toBe(true);
  });

  it("identical content is not a change (no churn on every poll)", () => {
    expect(decideSyncBack(fp("aaa"), fp("aaa")).changed).toBe(false);
  });

  it("absent current file is NEVER a change (don't push a deletion as a rotation)", () => {
    expect(decideSyncBack(fp("aaa"), null).changed).toBe(false);
    expect(decideSyncBack(null, null).changed).toBe(false);
  });
});

describe("syncBackSweep", () => {
  function target(content: string) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "sb-"));
    tmp.push(d);
    const f = path.join(d, "auth.json");
    fs.writeFileSync(f, content);
    return { agentId: "octogee-a-coach", authPath: f };
  }

  it("observe mode: a changed credential is logged, NEVER pushed", async () => {
    const t = target('{"tokens":{"refresh_token":"v1"}}');
    const logs: string[] = [];
    let pushed = 0;
    const r = await syncBackSweep({
      targets: [t],
      prev: new Map(),
      mode: "observe",
      pushCredential: async () => {
        pushed++;
      },
      logFn: (m) => logs.push(m),
    });
    expect(pushed).toBe(0);
    expect(r.observed).toBe(1);
    expect(r.pushed).toBe(0);
    expect(logs.join("\n")).toMatch(/octogee-a-coach/);
    // prev advanced so a steady file doesn't re-log every sweep
    const r2 = await syncBackSweep({
      targets: [t],
      prev: r.prev,
      mode: "observe",
    });
    expect(r2.observed).toBe(0);
  });

  it("active mode: a rotation is pushed with the file payload; prev advances", async () => {
    const t = target('{"tokens":{"refresh_token":"v1"}}');
    const seen: Array<{ agentId: string; payload: string }> = [];
    const r = await syncBackSweep({
      targets: [t],
      prev: new Map(),
      mode: "active",
      pushCredential: async (agentId, payload) => {
        seen.push({ agentId, payload });
      },
    });
    expect(r.pushed).toBe(1);
    expect(seen[0].agentId).toBe("octogee-a-coach");
    expect(JSON.parse(seen[0].payload).tokens.refresh_token).toBe("v1");
    // rotate the file; next sweep pushes the new payload
    fs.writeFileSync(t.authPath, '{"tokens":{"refresh_token":"v2"}}');
    const r2 = await syncBackSweep({
      targets: [t],
      prev: r.prev,
      mode: "active",
      pushCredential: async (agentId, payload) => {
        seen.push({ agentId, payload });
      },
    });
    expect(r2.pushed).toBe(1);
    expect(JSON.parse(seen[1].payload).tokens.refresh_token).toBe("v2");
  });

  it("active push failure: counts failed, does NOT advance prev (retry next sweep), never throws", async () => {
    const t = target('{"tokens":{"refresh_token":"v1"}}');
    const r = await syncBackSweep({
      targets: [t],
      prev: new Map(),
      mode: "active",
      pushCredential: async () => {
        throw new Error("gateway-edge 503");
      },
    });
    expect(r.pushed).toBe(0);
    expect(r.failed).toBe(1);
    // prev NOT advanced → next sweep retries
    let retried = 0;
    const r2 = await syncBackSweep({
      targets: [t],
      prev: r.prev,
      mode: "active",
      pushCredential: async () => {
        retried++;
      },
    });
    expect(retried).toBe(1);
    expect(r2.pushed).toBe(1);
  });

  it("unchanged + absent files are no-ops", async () => {
    const t = target('{"tokens":{"x":1}}');
    const r = await syncBackSweep({ targets: [t], prev: new Map(), mode: "observe" });
    const r2 = await syncBackSweep({ targets: [t], prev: r.prev, mode: "observe" });
    expect(r2.observed).toBe(0);
    const gone = { agentId: "octogee-b-coach", authPath: "/no/such/auth.json" };
    const r3 = await syncBackSweep({ targets: [gone], prev: new Map(), mode: "active" });
    expect(r3).toMatchObject({ pushed: 0, observed: 0, failed: 0 });
  });
});
