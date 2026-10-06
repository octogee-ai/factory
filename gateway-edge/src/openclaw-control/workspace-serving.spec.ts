import { describe, expect, it } from "vitest";
import { workspaceServingResolver } from "./workspace-serving.js";

function store(loaded: boolean, state?: "serving" | "quiescing" | "migrating") {
  return {
    loaded: () => loaded,
    get: (uid: string) => uid === "owner" && state ? { uid, state, epoch: 1 } : undefined,
  };
}

describe("workspace serving resolver", () => {
  it("serves only once the roster stamps the owner serving on this gateway", () => {
    expect(workspaceServingResolver({ GATEWAY_OWNER_UID: "owner" }, store(true, "serving"))()).toBe("serving");
    expect(workspaceServingResolver({ GATEWAY_OWNER_UID: "owner" }, store(true))()).toBe("not-serving");
    expect(workspaceServingResolver({ GATEWAY_OWNER_UID: "owner" }, store(true, "quiescing"))()).toBe("not-serving");
    expect(workspaceServingResolver({ GATEWAY_OWNER_UID: "owner" }, store(true, "migrating"))()).toBe("not-serving");
  });

  it("fails closed while the roster has not loaded or is unavailable", () => {
    expect(workspaceServingResolver({ GATEWAY_OWNER_UID: "owner" }, store(false, "serving"))()).toBe("roster-loading");
    expect(workspaceServingResolver({ GATEWAY_OWNER_UID: "owner" }, null)()).toBe("roster-loading");
  });

  it("does not fence a gateway that is not bound to an owner", () => {
    expect(workspaceServingResolver({}, store(false))()).toBe("serving");
    expect(workspaceServingResolver({ GATEWAY_OWNER_UID: " " }, null)()).toBe("serving");
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
