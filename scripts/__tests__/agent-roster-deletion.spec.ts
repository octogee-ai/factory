import { describe, expect, it, vi } from "vitest";
import { deleteRosterAgents } from "../lib/agent-roster-deletion.js";
import { OpenclawWireError, type GatewayRpcClient } from "../lib/gateway-rpc.js";

vi.mock("../lib/config.js", async () => {
  const actual: object = await vi.importActual("../lib/config.js");
  return { ...actual, log: vi.fn() };
});

function notFound(agentId: string): OpenclawWireError {
  return new OpenclawWireError("rpc-error", `agent "${agentId}" not found`, {
    serverCode: "INVALID_REQUEST",
  });
}

function mkRpc(
  impl: (params: { agentId: string; deleteFiles?: boolean }) => Promise<unknown>,
): Pick<GatewayRpcClient, "agentsDelete"> {
  return { agentsDelete: vi.fn(impl) } as unknown as Pick<GatewayRpcClient, "agentsDelete">;
}

describe("deleteRosterAgents", () => {
  it("deletes each departing agent exactly once, in order", async () => {
    const seen: string[] = [];
    const rpc = mkRpc(async ({ agentId }) => {
      seen.push(agentId);
      return { ok: true, agentId, removedBindings: 1 };
    });

    const results = await deleteRosterAgents(
      ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"],
      { rpc, log: vi.fn(), logPrefix: "[remove:alice]" },
    );

    expect(seen).toEqual(["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]);
    expect(rpc.agentsDelete).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { agentId: "octogee-alice-coach", status: "deleted" },
      { agentId: "octogee-alice-proj-orbit-coach", status: "deleted" },
    ]);
  });

  // A coach's openclaw workspace IS the customer directory. Letting openclaw
  // trash it would destroy a retained customer's checkout during a cancelled
  // eviction and would override a cleanup job's `deleteWorkspace: false`.
  it("never lets openclaw delete the departing agent's files", async () => {
    const rpc = mkRpc(async ({ agentId }) => ({ ok: true, agentId, removedBindings: 0 }));

    await deleteRosterAgents(["octogee-alice-coach"], { rpc, log: vi.fn() });

    expect(rpc.agentsDelete).toHaveBeenCalledWith({
      agentId: "octogee-alice-coach",
      deleteFiles: false,
    });
  });

  it("tolerates a not-found agent so a retried eviction still completes", async () => {
    const log = vi.fn();
    const rpc = mkRpc(async ({ agentId }) => {
      if (agentId === "octogee-alice-proj-orbit-coach") throw notFound(agentId);
      return { ok: true, agentId, removedBindings: 0 };
    });

    const results = await deleteRosterAgents(
      ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"],
      { rpc, log, logPrefix: "[remove:alice]" },
    );

    expect(results).toEqual([
      { agentId: "octogee-alice-coach", status: "deleted" },
      { agentId: "octogee-alice-proj-orbit-coach", status: "not-found" },
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("octogee-alice-proj-orbit-coach"),
    );
  });

  it("attempts every agent before throwing, and names each failure", async () => {
    const rpc = mkRpc(async ({ agentId }) => {
      if (agentId === "octogee-alice-coach") {
        throw new OpenclawWireError("rpc-error", "config mutation lock timed out");
      }
      return { ok: true, agentId, removedBindings: 0 };
    });

    await expect(
      deleteRosterAgents(
        ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"],
        { rpc, log: vi.fn(), logPrefix: "[remove:alice]" },
      ),
    ).rejects.toThrow(/octogee-alice-coach.*config mutation lock timed out/s);

    expect(rpc.agentsDelete).toHaveBeenCalledTimes(2);
  });

  it("fails the eviction when a delete is refused for a non-not-found reason", async () => {
    const rpc = mkRpc(async ({ agentId }) => {
      throw new OpenclawWireError(
        "rpc-error",
        `Agent "${agentId}" is the default and cannot be deleted. Reassign default first.`,
      );
    });

    await expect(
      deleteRosterAgents(["octogee-alice-coach"], { rpc, log: vi.fn() }),
    ).rejects.toThrow(/octogee-alice-coach/);
  });

  it("does no RPC work for an empty departing set", async () => {
    const rpc = mkRpc(async () => ({ ok: true }));

    await expect(deleteRosterAgents([], { rpc, log: vi.fn() })).resolves.toEqual([]);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
  });
});

describe("customerAgentIdsInRoster", () => {
  it("reads the keyed roster 2026.7.2 migrates to and keeps only the slug's agents", async () => {
    const { customerAgentIdsInRoster } = await import("../lib/agent-roster-deletion.js");

    expect(
      customerAgentIdsInRoster(
        {
          agents: {
            entries: {
              main: {},
              "octogee-ops-eggman": {},
              "octogee-alice-coach": {},
              "octogee-alice-proj-orbit-coach": {},
              "octogee-alicia-coach": {},
            },
          },
        },
        "alice",
      ),
    ).toEqual(["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]);
  });

  it("still reads the legacy list roster", async () => {
    const { customerAgentIdsInRoster } = await import("../lib/agent-roster-deletion.js");

    expect(
      customerAgentIdsInRoster(
        { agents: { list: [{ id: "octogee-bob-coach" }, { id: "octogee-alice-coach" }] } },
        "alice",
      ),
    ).toEqual(["octogee-alice-coach"]);
  });
});
