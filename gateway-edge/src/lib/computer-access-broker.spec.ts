import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  computerAccessRole,
  computerControlAllowed,
  resolveComputerAccess,
} from "./computer-access-broker.js";

const dir = mkdtempSync(join(tmpdir(), "computer-access-"));
const tokenPath = join(dir, "token");
writeFileSync(tokenPath, "projected-sa-token\n");

function brokerStub(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

const args = {
  gatewayId: "b-alice",
  authorization: "Bearer firebase-token",
  baseUrl: "http://octogee-api:3001",
  tokenPath,
};

describe("computerAccessRole / computerControlAllowed", () => {
  const resolved = { brokerProfile: null, dashboard: true, config: false, workspaceManagement: false, grantRevision: 1, expiresAt: null };

  it("maps platform principal access onto the computer roles", () => {
    expect(computerAccessRole({ kind: "owner", permissionSetIds: [], ...resolved })).toBe("owner");
    expect(computerAccessRole({ kind: "delegate", permissionSetIds: ["co-owner.v1"], ...resolved })).toBe("co-owner");
    expect(computerAccessRole({ kind: "delegate", permissionSetIds: ["trusted-helper.v1"], ...resolved })).toBe("trusted-helper");
    expect(computerAccessRole({ kind: "member", permissionSetIds: [], ...resolved })).toBe("member");
    expect(computerAccessRole({ kind: "delegate", permissionSetIds: ["agent-viewer.v1"], ...resolved })).toBeNull();
    expect(computerAccessRole({ kind: "denied", reason: "grant_missing" })).toBeNull();
  });

  it("lets only the Builder and a co-owner drive", () => {
    expect(computerControlAllowed("owner")).toBe(true);
    expect(computerControlAllowed("co-owner")).toBe(true);
    expect(computerControlAllowed("trusted-helper")).toBe(false);
    expect(computerControlAllowed("member")).toBe(false);
  });
});

describe("resolveComputerAccess", () => {
  it("posts the caller's bearer plus the projected token and returns the grant", async () => {
    const fetchImpl = brokerStub(200, {
      gatewayId: "b-alice", workspaceSlug: "alice", role: "member", permissionSetIds: [], canControl: false,
    });
    await expect(resolveComputerAccess({ ...args, fetchImpl })).resolves.toEqual({
      kind: "allowed", gatewayId: "b-alice", workspaceSlug: "alice", role: "member", permissionSetIds: [], canControl: false,
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://octogee-api:3001/internal/computer/access");
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer firebase-token");
    expect(headers.get("x-k8s-sa-token")).toBe("projected-sa-token");
    expect(init.body).toBe(JSON.stringify({ gatewayId: "b-alice" }));
  });

  it("maps 401/403/404 to outcomes and refuses other statuses", async () => {
    await expect(resolveComputerAccess({ ...args, fetchImpl: brokerStub(401, {}) })).resolves.toEqual({ kind: "unauthenticated" });
    await expect(resolveComputerAccess({ ...args, fetchImpl: brokerStub(403, {}) })).resolves.toEqual({ kind: "forbidden" });
    await expect(resolveComputerAccess({ ...args, fetchImpl: brokerStub(404, {}) })).resolves.toEqual({ kind: "not_found" });
    await expect(resolveComputerAccess({ ...args, fetchImpl: brokerStub(502, {}) })).rejects.toThrow(/returned 502/);
  });

  it("refuses a grant whose canControl disagrees with its role or names another gateway", async () => {
    await expect(resolveComputerAccess({ ...args, fetchImpl: brokerStub(200, {
      gatewayId: "b-alice", workspaceSlug: "alice", role: "member", permissionSetIds: [], canControl: true,
    }) })).rejects.toThrow(/malformed grant/);
    await expect(resolveComputerAccess({ ...args, fetchImpl: brokerStub(200, {
      gatewayId: "b-mallory", workspaceSlug: "alice", role: "owner", permissionSetIds: [], canControl: true,
    }) })).rejects.toThrow(/malformed grant/);
  });

  it("short-circuits without a bearer or with an invalid gateway id", async () => {
    const fetchImpl = brokerStub(200, {});
    await expect(resolveComputerAccess({ ...args, authorization: undefined, fetchImpl })).resolves.toEqual({ kind: "unauthenticated" });
    await expect(resolveComputerAccess({ ...args, gatewayId: "not a gateway", fetchImpl })).resolves.toEqual({ kind: "not_found" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to talk to a broker outside octogee-api", async () => {
    await expect(resolveComputerAccess({ ...args, baseUrl: "https://evil.example", fetchImpl: brokerStub(200, {}) }))
      .rejects.toThrow(/must target octogee-api/);
  });
});
