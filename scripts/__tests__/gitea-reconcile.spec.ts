import { describe, it, expect } from "vitest";
import {
  planGiteaReconcile,
  type ReconcileState,
  type ReconcileAction,
} from "../lib/gitea-reconcile.js";

const ALLOWED_KINDS = new Set<ReconcileAction["kind"]>([
  "ensure-org",
  "ensure-system-config-repo",
  "transfer-repo",
  "rename-repo",
  "firestore-repoint",
]);

function wsRepo(over: Partial<ReconcileState["repos"][number]> = {}) {
  return {
    kind: "workspace" as const,
    oldName: "tester90-workspace",
    newName: "workspace",
    atOldOrgOldName: true,
    atNewOrgOldName: false,
    atNewOrgNewName: false,
    ...over,
  };
}
function base(over: Partial<ReconcileState> = {}): ReconcileState {
  return {
    slug: "tester90",
    oldOrg: "octogee",
    orgExists: false,
    systemConfigRepoExists: true,
    firestoreStale: true,
    repos: [wsRepo()],
    ...over,
  };
}

describe("planGiteaReconcile", () => {
  it("legacy customer → full ordered, non-destructive plan", () => {
    const plan = planGiteaReconcile(
      base({
        repos: [
          wsRepo(),
          {
            kind: "project",
            projectSlug: "blog",
            oldName: "tester90-blog",
            newName: "blog",
            atOldOrgOldName: true,
            atNewOrgOldName: false,
            atNewOrgNewName: false,
          },
        ],
      }),
    );
    expect(plan.problems).toEqual([]);
    expect(plan.actions).toEqual([
      { kind: "ensure-org", slug: "tester90" },
      { kind: "transfer-repo", fromOwner: "octogee", repo: "tester90-workspace", toOwner: "tester90" },
      { kind: "rename-repo", owner: "tester90", from: "tester90-workspace", to: "workspace" },
      { kind: "transfer-repo", fromOwner: "octogee", repo: "tester90-blog", toOwner: "tester90" },
      { kind: "rename-repo", owner: "tester90", from: "tester90-blog", to: "blog" },
      { kind: "firestore-repoint", slug: "tester90" },
    ]);
  });

  it("never emits a destructive action; kinds are a closed set", () => {
    const plan = planGiteaReconcile(base());
    for (const a of plan.actions) {
      expect(ALLOWED_KINDS.has(a.kind)).toBe(true);
      expect(JSON.stringify(a)).not.toMatch(/delete|remove|destroy|archive/i);
    }
  });

  it("already fully migrated → empty plan (idempotent)", () => {
    const plan = planGiteaReconcile(
      base({
        orgExists: true,
        firestoreStale: false,
        repos: [
          wsRepo({ atOldOrgOldName: false, atNewOrgNewName: true }),
        ],
      }),
    );
    expect(plan).toEqual({ actions: [], problems: [] });
  });

  it("repairs a missing durable system_config repo", () => {
    const plan = planGiteaReconcile({
      ...base({
        orgExists: true,
        firestoreStale: false,
        repos: [wsRepo({ atOldOrgOldName: false, atNewOrgNewName: true })],
      }),
      systemConfigRepoExists: false,
    });

    expect(plan).toEqual({
      actions: [
        { kind: "ensure-org", slug: "tester90" },
        { kind: "ensure-system-config-repo", slug: "tester90" },
      ],
      problems: [],
    });
  });

  it("resumable: transferred-not-renamed → only rename (+ ensures, repoint)", () => {
    const plan = planGiteaReconcile(
      base({
        orgExists: true,
        firestoreStale: true,
        repos: [
          wsRepo({ atOldOrgOldName: false, atNewOrgOldName: true }),
        ],
      }),
    );
    expect(plan.problems).toEqual([]);
    expect(plan.actions).toEqual([
      { kind: "ensure-org", slug: "tester90" },
      { kind: "rename-repo", owner: "tester90", from: "tester90-workspace", to: "workspace" },
      { kind: "firestore-repoint", slug: "tester90" },
    ]);
  });

  it("resumable: repos done but Firestore stale → only ensures + repoint", () => {
    const plan = planGiteaReconcile(
      base({
        orgExists: true,
        firestoreStale: true,
        repos: [wsRepo({ atOldOrgOldName: false, atNewOrgNewName: true })],
      }),
    );
    expect(plan.actions).toEqual([
      { kind: "ensure-org", slug: "tester90" },
      { kind: "firestore-repoint", slug: "tester90" },
    ]);
  });

  it("a repo locatable nowhere → loud problem, no transfer/rename for it", () => {
    const plan = planGiteaReconcile(
      base({
        repos: [
          wsRepo({
            atOldOrgOldName: false,
            atNewOrgOldName: false,
            atNewOrgNewName: false,
          }),
        ],
      }),
    );
    expect(plan.problems.length).toBe(1);
    expect(plan.problems[0]).toMatch(/workspace.*tester90-workspace/i);
    expect(plan.actions.some((a) => a.kind === "transfer-repo" || a.kind === "rename-repo")).toBe(false);
  });

  it("is pure — same input yields an identical plan (dry-run == apply)", () => {
    const s = base({
      repos: [
        wsRepo(),
        {
          kind: "project",
          projectSlug: "x",
          oldName: "tester90-x",
          newName: "x",
          atOldOrgOldName: true,
          atNewOrgOldName: false,
          atNewOrgNewName: false,
        },
      ],
    });
    expect(planGiteaReconcile(s)).toEqual(planGiteaReconcile(s));
  });
});
