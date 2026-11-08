import { describe, expect, it } from "vitest";
import type { AdminRequest } from "./harness.js";
import { SHA, describeFleet, fleet, mutations, onlyMutation } from "./harness.js";

const GATEWAY_MUTATIONS: readonly { readonly argv: readonly string[]; readonly request: AdminRequest }[] = [
  {
    argv: ["gateway", "deploy", "shared-a", `--sha=${SHA}`],
    request: { method: "POST", path: "/api/admin/gateways/shared-a/deploy", body: { sourceSha: SHA } },
  },
  {
    argv: ["gateway", "restart", "shared-a"],
    request: { method: "POST", path: "/api/admin/gateways/shared-a/restart" },
  },
  {
    argv: ["gateway", "park", "shared-a"],
    request: { method: "PATCH", path: "/api/admin/gateways/shared-a", body: { desiredStatus: "paused" } },
  },
  {
    argv: ["gateway", "resume", "shared-parked"],
    request: { method: "PATCH", path: "/api/admin/gateways/shared-parked", body: { desiredStatus: "running" } },
  },
  {
    argv: ["gateway", "retire", "shared-b"],
    request: { method: "DELETE", path: "/api/admin/gateways/shared-b" },
  },
  {
    argv: ["gateway", "retire", "shared-b", "--retain-data", "--retain-service-account"],
    request: { method: "DELETE", path: "/api/admin/gateways/shared-b", query: { retainData: "true", retainServiceAccount: "true" } },
  },
  {
    argv: ["gateway", "rollback", "shared-a", "--release=7"],
    request: { method: "POST", path: "/api/admin/gateways/shared-a/releases/7/rollback" },
  },
  {
    argv: ["gateway", "recover-source", "shared-a", `--sha=${SHA}`],
    request: { method: "POST", path: "/api/admin/gateways/shared-a/recover-source", body: { sourceSha: SHA } },
  },
  {
    argv: ["gateway", "recover-source", "shared-a", `--sha=${SHA}`, "--supersede-recovery=rec-1"],
    request: {
      method: "POST",
      path: "/api/admin/gateways/shared-a/recover-source",
      body: { sourceSha: SHA, supersedeRecoveryId: "rec-1" },
    },
  },
  {
    argv: ["gateway", "recover-restore", "shared-a", `--sha=${SHA}`, "--operation=op-1"],
    request: {
      method: "POST",
      path: "/api/admin/gateways/shared-a/recover-restore",
      body: { sourceSha: SHA, operationId: "op-1" },
    },
  },
  {
    argv: ["gateway", "replace-vm", "iso-grace"],
    request: { method: "POST", path: "/api/admin/gateways/iso-grace/vm/replace", body: {} },
  },
];

describeFleet("gateway commands", () => {
  it.each(GATEWAY_MUTATIONS)("$argv sends $request.method $request.path", async ({ argv, request }) => {
    const run = await fleet([...argv, "--apply"]);
    expect(run.exitCode).toBe(0);
    expect(onlyMutation(run)).toEqual(request);
  });

  it("registers a gateway with its id, image tag and class; the image repository comes from the environment", async () => {
    const run = await fleet(["gateway", "add", "--id=shared-c", "--image-tag=v42", "--class=shared", "--apply"]);
    expect(run.exitCode).toBe(0);
    const request = onlyMutation(run);
    expect(request).toMatchObject({ method: "POST", path: "/api/admin/gateways" });
    expect(request.body).toMatchObject({ gatewayId: "shared-c", imageTag: "v42", gatewayClass: "shared" });
    expect(typeof request.body?.imageRepository).toBe("string");
  });

  it("registers an isolated gateway for one owner", async () => {
    const run = await fleet(["gateway", "add", "--id=iso-alan", "--image-tag=v42", "--class=isolated", "--owner=alan", "--apply"]);
    expect(onlyMutation(run).body).toMatchObject({ gatewayId: "iso-alan", gatewayClass: "isolated", ownerId: "u-alan" });
  });

  it.each([
    ["gateway", "deploy", "shared-a", "--sha=main"],
    ["gateway", "deploy", "shared-a", `--sha=${SHA.toUpperCase()}`],
    ["gateway", "deploy", "shared-a", `--sha=${SHA.slice(0, 12)}`],
    ["gateway", "recover-source", "shared-a", "--sha=abc"],
  ])("refuses anything but a full lowercase commit sha: %s %s %s %s", async (...argv) => {
    const run = await fleet([...argv, "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("refuses a recovery id that is a path", async () => {
    const run = await fleet(["gateway", "recover-source", "shared-a", `--sha=${SHA}`, "--supersede-recovery=a/b", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("requires both break-glass flags to replace a VM with boot-disk loss", async () => {
    const half = await fleet(["gateway", "replace-vm", "iso-grace", "--force", "--apply"]);
    expect(half.exitCode).not.toBe(0);
    expect(mutations(half)).toEqual([]);

    const full = await fleet(["gateway", "replace-vm", "iso-grace", "--force", "--accept-boot-data-loss", "--apply"]);
    expect(onlyMutation(full).body).toEqual({ force: true, acceptBootDataLoss: true });
    expect(full.stdout).toMatch(/boot disk/i);
  });

  it("refuses to restart with extra positional arguments", async () => {
    const run = await fleet(["gateway", "restart", "shared-a", "shared-b", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("lists gateways with read requests only", async () => {
    const run = await fleet(["gateway", "ls"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    for (const id of ["shared-a", "shared-b", "iso-grace", "shared-parked"]) expect(run.stdout).toContain(id);
  });

  it("inspects one gateway with read requests only", async () => {
    const run = await fleet(["gateway", "inspect", "iso-grace"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.stdout).toContain("iso-grace");
  });

  it("lists a gateway's releases with read requests only", async () => {
    const run = await fleet(["gateway", "releases", "shared-a"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("accepts gw as a short form of gateway", async () => {
    const run = await fleet(["gw", "park", "shared-a", "--apply"]);
    expect(onlyMutation(run)).toEqual({ method: "PATCH", path: "/api/admin/gateways/shared-a", body: { desiredStatus: "paused" } });
  });
});

describe("gateway commands outside the Admin API", () => {
  it.todo("gateway restart --force journals the restart, then deletes exactly the one pod labelled with that gateway id");
  it.todo("gateway restart --force refuses a shared gateway");
  it.todo("gateway restart --resolve-force=<audit-id> settles a force restart whose pod deletion was interrupted");
  it.todo("gateway move-users <source> --to=<target> [--users=<a,b>] moves every listed user, or all of them, through journaled migrations");
});
