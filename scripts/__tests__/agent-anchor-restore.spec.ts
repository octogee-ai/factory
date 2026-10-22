import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { runAgentAnchorRestore } from "../entrypoints/agent-anchor-restore.js";
import { withBuilderClaim } from "./helpers/builder-claim.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const coach = { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };

describe("agent-anchor-restore entrypoint", () => {
  it("lands the Builder's recorded anchors for configured agents before OpenClaw opens them", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-anchor-restore-")));
    roots.push(dir);
    const readAgentAnchors = vi.fn(async () => ({ anchors: [coach, { agentId: "octogee-alice-proj-gone-coach", storeId: "3313965d-1e56-4006-9d9c-1b0289fafcfa", schema: "octogee_agent_3313965d1e564006" }] }));
    const logs: string[] = [];

    const verify = vi.fn(async () => undefined);
    const result = await runAgentAnchorRestore({
      env: withBuilderClaim({ GATEWAY_CLASS: "builder", GATEWAY_ID: "alice-s-abc", OPENCLAW_STATE_DIR: dir }, "alice"),
      broker: { readAgentAnchors },
      readConfig: () => ({ agents: { entries: { [coach.agentId]: {}, "octogee-unmatched-route": {} } } }),
      verify,
      log: (m) => logs.push(m),
    });

    expect(result).toEqual({ landed: [coach.agentId], preserved: [], skipped: false });
    expect(verify).toHaveBeenCalledExactlyOnceWith(coach);
    expect(readAgentAnchors).toHaveBeenCalledExactlyOnceWith({ slug: "alice" });
    expect(readPostgresAgentAnchor(path.join(dir, "agents", coach.agentId, "agent", "openclaw-agent.sqlite"))).toEqual({ storeId: coach.storeId, schema: coach.schema });
    await expect(fs.stat(path.join(dir, "agents", "octogee-alice-proj-gone-coach"))).rejects.toThrow();
    expect(logs.some((m) => m.includes("landed 1 agent anchor"))).toBe(true);
  });

  it("skips a Shared gateway and a Builder without a claim", async () => {
    const readAgentAnchors = vi.fn();
    expect(await runAgentAnchorRestore({ env: { GATEWAY_CLASS: "shared", GATEWAY_ID: "shared-a" }, broker: { readAgentAnchors }, readConfig: () => ({}), log: () => {} }))
      .toEqual({ landed: [], preserved: [], skipped: true });
    expect(await runAgentAnchorRestore({ env: { GATEWAY_CLASS: "builder", GATEWAY_ID: "alice-s-abc" }, broker: { readAgentAnchors }, readConfig: () => ({}), log: () => {} }))
      .toEqual({ landed: [], preserved: [], skipped: true });
    expect(readAgentAnchors).not.toHaveBeenCalled();
  });
});
