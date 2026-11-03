import { describe, expect, it } from "vitest";
import type { BuilderIdentity } from "@octogee/shared/types/builder-identity";
import { workspaceServingResolver } from "./workspace-serving.js";

function store(loaded: boolean, state?: "serving" | "quiescing" | "migrating") {
  return {
    loaded: () => loaded,
    get: (uid: string) => uid === "owner" && state ? { uid, state, epoch: 1 } : undefined,
  };
}

const CLAIMED: BuilderIdentity = {
  gatewayId: "b-owner", state: "claimed", ownerUid: "owner", builderSlug: "owner", leaseId: null, generation: null,
};

function builder(identity: BuilderIdentity | null, roster: ReturnType<typeof store> | null) {
  return workspaceServingResolver({ gatewayClass: "builder", identity: () => identity, store: roster });
}

describe("workspace serving resolver", () => {
  it("serves only once the roster stamps the claimed owner serving on this gateway", () => {
    expect(builder(CLAIMED, store(true, "serving"))()).toBe("serving");
    expect(builder(CLAIMED, store(true))()).toBe("not-serving");
    expect(builder(CLAIMED, store(true, "quiescing"))()).toBe("not-serving");
    expect(builder(CLAIMED, store(true, "migrating"))()).toBe("not-serving");
  });

  it("fails closed while the roster has not loaded or is unavailable", () => {
    expect(builder(CLAIMED, store(false, "serving"))()).toBe("roster-loading");
    expect(builder(CLAIMED, null)()).toBe("roster-loading");
  });

  it.each<[string, BuilderIdentity | null]>([
    ["not yet read", null],
    ["retired", { gatewayId: "b-owner", state: "unavailable", reason: "retired" }],
  ])("refuses a Builder whose identity is %s", (_label, identity) => {
    expect(builder(identity, store(true, "serving"))()).toBe("not-serving");
  });

  it("follows the Builder identity as it becomes claimed", () => {
    let identity: BuilderIdentity | null = null;
    const resolve = workspaceServingResolver({ gatewayClass: "builder", identity: () => identity, store: store(true, "serving") });
    expect(resolve()).toBe("not-serving");
    identity = CLAIMED;
    expect(resolve()).toBe("serving");
  });

  it("does not fence a shared gateway, which has no owner", () => {
    expect(workspaceServingResolver({ gatewayClass: "shared", identity: () => null, store: store(false) })()).toBe("serving");
  });
});

describe("workspace serving denial", () => {
  it("maps every non-serving state to a policy reason", async () => {
    const { workspaceServingDenial } = await import("./workspace-serving.js");
    expect(workspaceServingDenial("serving")).toBeNull();
    expect(workspaceServingDenial("not-serving")).toBe("workspace-not-serving");
    expect(workspaceServingDenial("roster-loading")).toBe("roster-loading");
  });
});
