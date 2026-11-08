import { describe, expect, it } from "vitest";
import type { AdminRequest } from "./harness.js";
import { FIXTURE, describeFleet, fleet, mutations, onlyMutation } from "./harness.js";

const USER_MUTATIONS: readonly { readonly argv: readonly string[]; readonly request: AdminRequest }[] = [
  {
    argv: ["user", "assign", "alan", "--to=shared-a"],
    request: { method: "POST", path: "/api/admin/users/u-alan/assign", body: { gatewayId: "shared-a" } },
  },
  {
    argv: ["user", "migrate", "ada", "--to=shared-b"],
    request: { method: "POST", path: "/api/admin/users/u-ada/migrate", body: { to: "shared-b" } },
  },
  {
    argv: ["user", "migrate", "ada", "--to=shared-b", "--source-transfer=retained-pod"],
    request: { method: "POST", path: "/api/admin/users/u-ada/migrate", body: { to: "shared-b", sourceTransfer: "retained-pod" } },
  },
  {
    argv: ["user", "unassign", "ada"],
    request: { method: "POST", path: "/api/admin/users/u-ada/unassign" },
  },
  {
    argv: ["user", "replace-vm", "grace"],
    request: { method: "POST", path: "/api/admin/users/u-grace/vm/replace", body: {} },
  },
  {
    argv: ["user", "delete", "alan"],
    request: { method: "POST", path: "/api/admin/users/u-alan/delete", body: { eraseNow: false } },
  },
  {
    argv: ["user", "delete", "alan", "--erase-now"],
    request: { method: "POST", path: "/api/admin/users/u-alan/delete", body: { eraseNow: true } },
  },
  {
    argv: ["user", "lease", "request", "grace"],
    request: { method: "POST", path: "/api/admin/users/u-grace/activation-lease" },
  },
  {
    argv: ["user", "lease", "cancel", "grace", "--lease=lease-1", "--generation=3"],
    request: { method: "POST", path: "/api/admin/users/u-grace/activation-lease/cancel", body: { leaseId: "lease-1", generation: 3 } },
  },
  {
    argv: ["user", "lease", "terminate", "grace", "--lease=lease-1", "--generation=3"],
    request: { method: "POST", path: "/api/admin/users/u-grace/activation-lease/terminate", body: { leaseId: "lease-1", generation: 3 } },
  },
  {
    argv: ["user", "lease", "return", "grace", "--lease=lease-1", "--generation=3"],
    request: { method: "POST", path: "/api/admin/users/u-grace/activation-lease/return", body: { leaseId: "lease-1", generation: 3 } },
  },
  {
    argv: ["user", "lease", "retry-return", "grace", "--operation=op-9"],
    request: { method: "POST", path: "/api/admin/users/u-grace/activation-lease/return/retry", body: { operationId: "op-9" } },
  },
];

describeFleet("user commands", () => {
  it.each(USER_MUTATIONS)("$argv sends $request.method $request.path", async ({ argv, request }) => {
    const run = await fleet([...argv, "--apply"]);
    expect(run.exitCode).toBe(0);
    expect(onlyMutation(run)).toEqual(request);
  });

  it("names a user by name or by id", async () => {
    const byName = await fleet(["user", "unassign", "ada", "--apply"]);
    const byId = await fleet(["user", "unassign", "u-ada", "--apply"]);
    expect(onlyMutation(byId)).toEqual(onlyMutation(byName));
  });

  it("does nothing when the user is already on the target gateway", async () => {
    const run = await fleet(["user", "assign", "ada", "--to=shared-a", "--apply"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("refuses to assign a user placed on another gateway and points at user migrate", async () => {
    const run = await fleet(["user", "assign", "ada", "--to=shared-b", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.stderr).toContain("user migrate");
  });

  it("refuses to assign a user to a parked gateway", async () => {
    const run = await fleet(["user", "assign", "alan", "--to=shared-parked", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("refuses to assign a user to another user's isolated gateway", async () => {
    const run = await fleet(["user", "assign", "alan", "--to=iso-grace", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("points a user with no gateway at assign instead of migrating", async () => {
    const run = await fleet(["user", "migrate", "alan", "--to=shared-a", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.stderr).toContain("user assign");
  });

  it("refuses an unknown source-transfer mode", async () => {
    const run = await fleet(["user", "migrate", "ada", "--to=shared-b", "--source-transfer=copy", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("requires both break-glass flags to replace a user's VM with boot-disk loss", async () => {
    const half = await fleet(["user", "replace-vm", "grace", "--accept-boot-data-loss", "--apply"]);
    expect(half.exitCode).not.toBe(0);
    expect(mutations(half)).toEqual([]);

    const full = await fleet(["user", "replace-vm", "grace", "--force", "--accept-boot-data-loss", "--apply"]);
    expect(onlyMutation(full).body).toEqual({ force: true, acceptBootDataLoss: true });
  });

  it("requires a lease id and an integer generation to cancel, terminate or return a lease", async () => {
    for (const argv of [
      ["user", "lease", "cancel", "grace", "--generation=3"],
      ["user", "lease", "terminate", "grace", "--lease=lease-1"],
      ["user", "lease", "return", "grace", "--lease=lease-1", "--generation=three"],
    ]) {
      const run = await fleet([...argv, "--apply"]);
      expect(run.exitCode).not.toBe(0);
      expect(mutations(run)).toEqual([]);
    }
  });

  it("lists users with read requests only, filtered by gateway", async () => {
    const run = await fleet(["user", "ls", "--gateway=shared-a"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.stdout).toContain("ada");
    expect(run.stdout).not.toContain("grace");
  });

  it("reports no drift when every placed user is mounted and every mounted user is placed", async () => {
    const run = await fleet(["user", "ls"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toMatch(/drift/i);
  });

  it("reports drift in both directions: placed but not mounted, and mounted but not placed", async () => {
    const drifted = {
      ...FIXTURE,
      gateways: FIXTURE.gateways.map(gateway =>
        gateway.id === "shared-a" ? { ...gateway, mountedUserIds: ["u-ada", "u-alan"] } :
        gateway.id === "iso-grace" ? { ...gateway, mountedUserIds: [] } :
        gateway),
    };
    const run = await fleet(["user", "ls"], drifted);
    expect(run.exitCode).toBe(0);
    const driftLines = run.stdout.split("\n").filter(line => /drift/i.test(line));
    expect(driftLines.some(line => line.includes("alan"))).toBe(true);
    expect(driftLines.some(line => line.includes("grace"))).toBe(true);
    expect(driftLines.some(line => line.includes("ada") && !line.includes("alan"))).toBe(false);
  });

  it("inspects one user with read requests only", async () => {
    const run = await fleet(["user", "inspect", "grace"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.stdout).toContain("iso-grace");
  });

  it("shows a user's model broker diagnostics with read requests only", async () => {
    const run = await fleet(["user", "broker", "ada"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
  });
});

describe("adding users from the command line", () => {
  it.todo("user add <name> creates and admits a user with an operator-issued identity");
  it.todo("an admitted user is placed on a gateway and gets a managed chat team and channels, a git organization and workspace repository, and an agent");
  it.todo("user add refuses a name that is already taken, and sends nothing");
});
