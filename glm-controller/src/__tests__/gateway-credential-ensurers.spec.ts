import { describe, expect, it, vi } from "vitest";
import { access, readFile, stat } from "node:fs/promises";
import type { AgentStoreGatewayIdentity } from "@octogee/core/agent-store-credentials";
import type { KubectlSubprocess } from "../auth-secret-ensurer.js";
import { createGatewayCredentialEnsurers } from "../gateway-credential-ensurers.js";

function harness() {
  const auth = { ensureAuthSecret: vi.fn(async () => {}) };
  const readGateway = vi.fn(async (): Promise<{ gatewayClass: "shared" | "builder"; ownerUid: string | null; builderSlug: string | null; desiredStatus: string; retirementClaim?: unknown } | null> => null);
  const provisionAgentStore = vi.fn(async (_identity: AgentStoreGatewayIdentity, assertCurrent: () => Promise<void>) => { await assertCurrent?.(); return "postgresql://gateway:synthetic@private/agents_test"; });
  const runKubectl = vi.fn<KubectlSubprocess>(async () => ({ code: 0, stdout: Buffer.from("synthetic-token").toString("base64"), stderr: "" }));
  return { auth, readGateway, provisionAgentStore, runKubectl, stages: createGatewayCredentialEnsurers({ auth, readGateway, provisionAgentStore, runKubectl }) };
}
const request = { namespace: "test", gatewayId: "fresh-builder" };

describe("Gateway credential provisioning stages", () => {
  it("allocates the token before the desired root exists and provisions SQL credentials before runtime start", async () => {
    const h = harness();
    await h.stages.ensureGatewayAuthSecret(request);
    expect(h.auth.ensureAuthSecret).toHaveBeenCalledWith(request);
    expect(h.readGateway).not.toHaveBeenCalled();
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "builder", ownerUid: "uid-alice", builderSlug: "alice" });
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).toHaveBeenCalledExactlyOnceWith({ gatewayId: request.gatewayId, gatewayClass: "builder", token: "synthetic-token", builder: { uid: "uid-alice", slug: "alice" } }, expect.any(Function));
  });

  it.each([{ desiredStatus: "retired" }, { retirementClaim: { operationId: "retire" } }, { retirementClaim: false }, { retirementClaim: "" }])("rejects issuance when retirement begins while waiting for SQL custody: %j", async retirement => {
    const h = harness();
    const gateway = { gatewayClass: "shared" as const, ownerUid: null, builderSlug: null, desiredStatus: "draining" };
    h.readGateway.mockResolvedValueOnce(gateway).mockResolvedValue({ ...gateway, ...retirement });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it("keeps draining Shared credential issuance available before a retirement claim", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining" });
    await expect(h.stages.ensureGatewayCredentials(request)).resolves.toBeUndefined();
  });

  it("does not publish credentials if custody changes after SQL issuance", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ gatewayClass: "builder", ownerUid: "uid-alice", builderSlug: "alice", desiredStatus: "running" });
    h.provisionAgentStore.mockImplementationOnce(async (_identity, assertCurrent) => {
      await assertCurrent();
      h.readGateway.mockResolvedValue({ gatewayClass: "builder", ownerUid: "uid-bob", builderSlug: "bob", desiredStatus: "running" });
      return "postgresql://synthetic";
    });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it("rechecks custody after private patch preparation before publishing", async () => {
    const h = harness();
    const gateway = { gatewayClass: "shared" as const, ownerUid: null, builderSlug: null, desiredStatus: "running" };
    h.readGateway.mockResolvedValueOnce(gateway).mockResolvedValueOnce(gateway).mockResolvedValueOnce(gateway)
      .mockResolvedValue({ ...gateway, desiredStatus: "retired" });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it("publishes a token-fenced update through a private file and removes it afterward", async () => {
    const h = harness();
    let patchPath = "";
    let patch: unknown;
    let mode = 0;
    let publicationArgs: string[] = [];
    h.runKubectl.mockImplementation(async args => {
      if (args[0] === "get") return { code: 0, stdout: Buffer.from("synthetic-token").toString("base64"), stderr: "" };
      publicationArgs = args;
      const fileArg = args.find(arg => arg.startsWith("--patch-file="));
      if (!fileArg) throw new Error("Credential publication requires a private patch file");
      patchPath = fileArg.slice("--patch-file=".length);
      patch = JSON.parse(await readFile(patchPath, "utf8"));
      mode = (await stat(patchPath)).mode & 0o777;
      return { code: 0, stdout: "", stderr: "" };
    });
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "shared", ownerUid: null, builderSlug: null });
    await h.stages.ensureGatewayCredentials(request);
    expect(publicationArgs).toEqual(["patch", "secret", "gateway-auth-token-fresh-builder", "-n", "test", "--type=json", `--patch-file=${patchPath}`]);
    expect(patch).toEqual([
      { op: "test", path: "/data/token", value: Buffer.from("synthetic-token").toString("base64") },
      { op: "add", path: "/data/agent-store-dsn", value: Buffer.from("postgresql://gateway:synthetic@private/agents_test").toString("base64") },
    ]);
    expect(mode).toBe(0o600);
    await expect(access(patchPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses runtime credentials without a durable root", async () => {
    const h = harness();
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("desired owner");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    expect(h.runKubectl).not.toHaveBeenCalled();
  });

  it("refuses incomplete desired ownership", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "builder", ownerUid: "uid-alice", builderSlug: null });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("desired owner");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
  });

  it.each(["shared", "builder"] as const)("keeps an unowned %s runtime unclaimed", async gatewayClass => {
    const h = harness();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass, ownerUid: null, builderSlug: null });
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).toHaveBeenCalledWith({ gatewayId: request.gatewayId, gatewayClass, token: "synthetic-token" }, expect.any(Function));
  });

  it("fails runtime preparation when scoped credentials cannot be published", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.runKubectl.mockResolvedValueOnce({ code: 0, stdout: Buffer.from("synthetic-token").toString("base64"), stderr: "" }).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "denied" });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("publication failed");
    const fileArg = h.runKubectl.mock.calls.at(-1)![0].find(arg => arg.startsWith("--patch-file="))!;
    await expect(access(fileArg.slice("--patch-file=".length))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
