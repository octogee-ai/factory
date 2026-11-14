import { describe, expect, it } from "vitest";
import { STEPS, parseStockArgs, runSteps, stockActions } from "../ops/kind-stock-openclaw.mjs";

const STEP_IDS = STEPS.map(step => step.id);

describe("kind-stock-openclaw", () => {
  it("runs the steps in order, stops at the first failure and skips the rest", async () => {
    const ran: string[] = [];
    const actions = Object.fromEntries(STEP_IDS.map(id => [id, async () => {
      ran.push(id);
      if (id === "identities") throw new Error("Timed out after 900s waiting for lin-s-1 to mark its workspace identities ready\nDiagnostics follow");
      return id === "reply" ? "1 call(s), $0.001557" : undefined;
    }]));
    const logged: string[] = [];

    const results = await runSteps(STEPS, actions, (line: string) => logged.push(line));

    expect(ran).toEqual(["placed", "reply", "migrate", "identities"]);
    expect(results.map(result => [result.id, result.status])).toEqual([
      ["placed", "passed"], ["reply", "passed"], ["migrate", "passed"],
      ["identities", "failed"], ["mounted", "skipped"], ["migrated", "skipped"],
    ]);
    expect(results[1].note).toBe("1 call(s), $0.001557");
    expect(results[3].detail).toBe("Timed out after 900s waiting for lin-s-1 to mark its workspace identities ready");
    expect(logged.join("\n")).toContain("Diagnostics follow");
  });

  it("redacts secrets from a failure before reporting it", async () => {
    const actions = Object.fromEntries(STEP_IDS.map(id => [id, async () => {
      throw new Error("Mattermost sign-in failed with Authorization: Bearer abc.def.ghi");
    }]));
    const [first] = await runSteps(STEPS, actions, () => {});
    expect(first.detail).not.toContain("abc.def.ghi");
    expect(first.detail).toContain("[redacted]");
  });

  it.each([
    [{ operationId: "op-1" }, "without a gateway id"],
    [{ gatewayId: "lin-s-1" }, "without an operation id"],
  ])("fails the migrate step when the answer is incomplete (%j)", async (response, message) => {
    const deps = { setSizingProfile: () => {}, fleet: () => ({ response }) };
    const { actions } = stockActions(deps, { user: "lin", gateway: "shared-a" });
    await expect(actions.migrate()).rejects.toThrow(message);
  });

  it("migrates the user to an isolated gateway with the pod sizing profile", async () => {
    const calls: string[][] = [];
    const deps = {
      setSizingProfile: (name: string) => calls.push(["sizing", name]),
      fleet: (args: string[]) => {
        calls.push(args);
        return { response: { gatewayId: "lin-s-1", operationId: "op-1" } };
      },
    };
    const { actions, state } = stockActions(deps, { user: "lin", gateway: "shared-a" });

    await expect(actions.migrate()).resolves.toBe("lin-s-1, operation op-1");
    expect(calls).toEqual([["sizing", "pod-s"], ["user", "migrate", "lin", "--to-isolated=pod-s", "--apply"]]);
    expect(state).toMatchObject({ gatewayId: "lin-s-1", operationId: "op-1" });
  });

  it("takes a report path beside the round-trip options", () => {
    const options = parseStockArgs(["--state=/tmp/kind", "--report=/tmp/report.json", "--model=platform-openrouter/meta/muse-ember"]);
    expect(options).toMatchObject({ state: "/tmp/kind", report: "/tmp/report.json", model: "platform-openrouter/meta/muse-ember" });
    expect(() => parseStockArgs(["--state=/tmp/kind", "--report="])).toThrow("--report needs a value");
  });
});
