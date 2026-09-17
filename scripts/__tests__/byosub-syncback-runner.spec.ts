import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmp: string[] = [];
const originalEnv = { ...process.env };

function mkHome(config: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "byosub-syncback-home-"));
  tmp.push(home);
  const openclaw = path.join(home, ".openclaw");
  fs.mkdirSync(openclaw, { recursive: true });
  fs.writeFileSync(path.join(openclaw, "openclaw.json"), JSON.stringify(config));
  return home;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("byosub-syncback-runner loadTargets", () => {
  it("does not attempt Firestore discovery on shared gateways", async () => {
    process.env.HOME = mkHome({
      agents: {
        list: [{ id: "octogee-tester19-coach" }],
      },
    });
    process.env.GATEWAY_ID = "default-green";
    process.env.GATEWAY_CLASS = "shared";

    const firebaseImport = vi.fn();
    vi.doMock("../lib/firebase.js", () => {
      firebaseImport();
      throw new Error("shared gateways must not import firebase");
    });

    const { loadTargets } = await import("../entrypoints/byosub-syncback-runner.js");

    await expect(loadTargets()).resolves.toEqual([]);
    expect(firebaseImport).not.toHaveBeenCalled();
  });

  it("observes only local, path-safe agent auth files without Firestore discovery", async () => {
    const home = mkHome({
      agents: {
        list: [
          { id: "octogee-tester19-coach" },
          { id: "../../not-an-agent" },
        ],
      },
    });
    process.env.HOME = home;
    process.env.GATEWAY_ID = "operator-tester19";
    process.env.GATEWAY_CLASS = "builder";

    const firebaseImport = vi.fn();
    vi.doMock("../lib/firebase.js", () => {
      firebaseImport();
      throw new Error("sync-back must not import firebase");
    });

    const { loadTargets } = await import("../entrypoints/byosub-syncback-runner.js");

    await expect(loadTargets()).resolves.toEqual([
      {
        agentId: "octogee-tester19-coach",
        authPath: path.join(
          home,
          ".openclaw",
          "agents",
          "octogee-tester19-coach",
          "agent",
          "codex-home",
          "auth.json",
        ),
      },
    ]);
    expect(firebaseImport).not.toHaveBeenCalled();
  });
});

describe("byosub-syncback-runner sweepOnce", () => {
  it("pushes a rotated codex credential through the broker on a Builder gateway", async () => {
    const home = mkHome({ agents: { entries: { "octogee-tester19-coach": {} } } });
    process.env.HOME = home;
    process.env.GATEWAY_ID = "tester19-m-abc";
    process.env.GATEWAY_CLASS = "builder";
    const authPath = path.join(
      home, ".openclaw", "agents", "octogee-tester19-coach", "agent", "codex-home", "auth.json",
    );
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, '{"tokens":{"access_token":"a1","refresh_token":"r1"}}');
    const push = vi.fn(async () => ({ changed: true, destroyed: 0 }));
    vi.doMock("../lib/byot-sync-runtime.js", () => ({ brokerPushByosubCred: push }));

    const { sweepOnce } = await import("../entrypoints/byosub-syncback-runner.js");
    const first = await sweepOnce(new Map());
    expect(push).toHaveBeenCalledWith(
      "octogee-tester19-coach",
      "openai",
      '{"tokens":{"access_token":"a1","refresh_token":"r1"}}',
    );

    push.mockClear();
    await sweepOnce(first.prev);
    expect(push).not.toHaveBeenCalled();

    fs.writeFileSync(authPath, '{"tokens":{"access_token":"a2","refresh_token":"r2"}}');
    await sweepOnce(first.prev);
    expect(push).toHaveBeenCalledWith(
      "octogee-tester19-coach",
      "openai",
      '{"tokens":{"access_token":"a2","refresh_token":"r2"}}',
    );
  });
});
