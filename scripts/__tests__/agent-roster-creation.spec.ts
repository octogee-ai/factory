import { describe, expect, it, vi } from "vitest";
import {
  createRosterAgents,
  rosterAgentSpecsFromEntries,
} from "../lib/agent-roster-creation.js";
import { OpenclawWireError } from "../lib/gateway-rpc.js";

function mkRpc(
  agentsCreate = vi.fn(async ({ name }: { name: string }) => ({
    ok: true as const,
    agentId: name,
    name,
    workspace: "/w",
  })),
) {
  return { rpc: { agentsCreate }, agentsCreate };
}

describe("rosterAgentSpecsFromEntries", () => {
  it("projects id and workspace out of built agent entries", () => {
    expect(
      rosterAgentSpecsFromEntries([
        { id: "octogee-alice-coach", workspace: "/c/alice", model: "house" },
        { id: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
      ]),
    ).toEqual([
      { agentId: "octogee-alice-coach", workspace: "/c/alice" },
      { agentId: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
    ]);
  });

  it("refuses an entry with no workspace — agents.create cannot invent one", () => {
    expect(() => rosterAgentSpecsFromEntries([{ id: "octogee-alice-coach" }])).toThrow(
      /octogee-alice-coach/,
    );
  });
});

describe("createRosterAgents", () => {
  it("creates each agent by passing the exact agent id as the name", async () => {
    const { rpc, agentsCreate } = mkRpc();

    const results = await createRosterAgents(
      [
        { agentId: "octogee-alice-coach", workspace: "/c/alice" },
        { agentId: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
      ],
      { rpc, log: vi.fn() },
    );

    expect(agentsCreate).toHaveBeenCalledTimes(2);
    expect(agentsCreate).toHaveBeenNthCalledWith(1, {
      name: "octogee-alice-coach",
      workspace: "/c/alice",
    });
    expect(results).toEqual([
      { agentId: "octogee-alice-coach", status: "created" },
      { agentId: "octogee-alice-proj-orbit-coach", status: "created" },
    ]);
  });

  it("fails loudly when the gateway hands back a different agent id than the name asked for", async () => {
    const agentsCreate = vi.fn(async () => ({
      ok: true as const,
      agentId: "octogee-alice-coach-2",
      name: "octogee-alice-coach",
      workspace: "/c/alice",
    }));

    await expect(
      createRosterAgents([{ agentId: "octogee-alice-coach", workspace: "/c/alice" }], {
        rpc: { agentsCreate },
        log: vi.fn(),
      }),
    ).rejects.toThrow(/octogee-alice-coach-2/);
  });

  it("treats an already-exists refusal as already-done", async () => {
    const agentsCreate = vi.fn(async () => {
      throw new OpenclawWireError("rpc-error", 'agent "octogee-alice-coach" already exists');
    });

    await expect(
      createRosterAgents([{ agentId: "octogee-alice-coach", workspace: "/c/alice" }], {
        rpc: { agentsCreate },
        log: vi.fn(),
      }),
    ).resolves.toEqual([{ agentId: "octogee-alice-coach", status: "already-exists" }]);
  });

  it("throws with every failed agent named when a create is refused for any other reason", async () => {
    const agentsCreate = vi.fn(async ({ name }: { name: string }) => {
      if (name === "octogee-alice-coach") {
        throw new OpenclawWireError("rpc-error", "workspace path is outside the state dir");
      }
      return { ok: true as const, agentId: name, name, workspace: "/w" };
    });

    await expect(
      createRosterAgents(
        [
          { agentId: "octogee-alice-coach", workspace: "/etc" },
          { agentId: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
        ],
        { rpc: { agentsCreate }, log: vi.fn(), logPrefix: "[add:alice]" },
      ),
    ).rejects.toThrow(/octogee-alice-coach \(workspace path is outside the state dir\)/);

    expect(agentsCreate).toHaveBeenCalledTimes(2);
  });

  it("does not call the gateway for an empty spec list", async () => {
    const { rpc, agentsCreate } = mkRpc();

    await expect(createRosterAgents([], { rpc, log: vi.fn() })).resolves.toEqual([]);
    expect(agentsCreate).not.toHaveBeenCalled();
  });
});
