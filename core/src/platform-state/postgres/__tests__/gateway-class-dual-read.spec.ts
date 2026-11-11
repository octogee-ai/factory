import { describe, expect, it } from "vitest";
import { createPostgresGatewayRepositories, decodeGatewayRoot } from "../gateways.js";
import type { PostgresSession } from "../session.js";
import { decodeUserRow } from "../user-records.js";

function gatewayRow(stored: string, image: string) {
  return {
    gateway_id: "walter",
    gateway_class: stored,
    profile: image,
    image_profile: image,
    desired_status: "running",
    revision: "7",
  };
}

function userRow(gatewayProfile: string) {
  return { uid: "u1", updated_at: 1, agent_ids: [], activated_agents: [], gateway_id: "walter", gateway_profile: gatewayProfile, revision: "3" };
}

describe("stored isolated class values read the same as builder", () => {
  it("decodes a gateway root stored with either isolated value identically", () => {
    const fromBuilder = decodeGatewayRoot(gatewayRow("builder", "builder"));
    const fromIsolated = decodeGatewayRoot(gatewayRow("isolated", "isolated"));
    expect(fromIsolated).toEqual(fromBuilder);
    expect(fromIsolated).toMatchObject({ gatewayClass: "builder", profile: "builder", imageProfile: "builder" });
  });

  it("passes shared, standard and unknown stored values through unchanged", () => {
    expect(decodeGatewayRoot(gatewayRow("shared", "standard"))).toMatchObject({ gatewayClass: "shared", profile: "standard", imageProfile: "standard" });
    expect(decodeGatewayRoot(gatewayRow("operator", "operator"))).toMatchObject({ gatewayClass: "operator", profile: "operator", imageProfile: "operator" });
  });

  it("decodes a user's gateway profile stored with either isolated value identically", () => {
    expect(decodeUserRow(userRow("isolated")).gateway).toEqual(decodeUserRow(userRow("builder")).gateway);
    expect(decodeUserRow(userRow("isolated")).gateway?.gatewayProfile).toBe("builder");
    expect(decodeUserRow(userRow("standard")).gateway?.gatewayProfile).toBe("standard");
  });

  it("lists isolated gateways stored under either value and shared gateways under their own", async () => {
    const queries: { sql: string; values: readonly unknown[] }[] = [];
    const session = {
      async read(_operation: string, sql: string, values: readonly unknown[]) { queries.push({ sql, values }); return []; },
    } as unknown as PostgresSession;
    const roots = createPostgresGatewayRepositories(session).roots;
    await roots.list({ gatewayClass: "builder" });
    await roots.list({ gatewayClass: "shared" });
    expect(queries.map((query) => query.values[0])).toEqual([["builder", "isolated"], ["shared"]]);
    expect(queries[0].sql).toContain("gateway_class = ANY(");
  });
});
