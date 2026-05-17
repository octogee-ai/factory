/**
 * Pure planner for the in-place, lossless Gitea reconcile (Track 2 / AD6).
 *
 * Legacy customers live on the pre-#963 scheme (shared `octogee` org,
 * repo `{slug}-workspace`, project `{ws}-{proj}`); new code reads the
 * per-workspace scheme (org `{slug}`, repo `workspace`, project `{proj}`).
 * This decides the ordered, idempotent, resumable, **never destructive**
 * action list to move a customer in place — only ensure / repo transfer /
 * repo rename / Firestore re-point; never a delete. The shared `octogee`
 * org is never renamed (it still holds not-yet-reconciled customers).
 *
 * Apply order is fixed: ensure org → ensure builder user → per-repo
 * transfer then rename → Firestore re-point LAST (so an abort leaves
 * Firestore pointing at a still-valid location and a re-run resumes).
 */

export type ReconcileAction =
  | { kind: "ensure-org"; slug: string }
  | { kind: "transfer-repo"; fromOwner: string; repo: string; toOwner: string }
  | { kind: "rename-repo"; owner: string; from: string; to: string }
  | { kind: "firestore-repoint"; slug: string };

export interface RepoState {
  kind: "workspace" | "project";
  projectSlug?: string;
  /** Legacy (octogee-era) repo name, e.g. `{slug}-workspace`. */
  oldName: string;
  /** New bare name: `workspace` or the project slug. */
  newName: string;
  /** octogee/{oldName} */
  atOldOrgOldName: boolean;
  /** {slug}/{oldName} — transferred but not yet renamed. */
  atNewOrgOldName: boolean;
  /** {slug}/{newName} — fully done. */
  atNewOrgNewName: boolean;
}

export interface ReconcileState {
  slug: string;
  /** The shared legacy org (always `octogee`); never mutated. */
  oldOrg: string;
  orgExists: boolean;
  /** Any of provisioning.git.repoUrl / workspaces/{slug}.gitea /
   *  project giteaRepoName still on the old scheme. */
  firestoreStale: boolean;
  /** Workspace repo first, then project repos. */
  repos: RepoState[];
}

export interface ReconcilePlan {
  actions: ReconcileAction[];
  /** Loud, non-empty ⇒ the ops tool refuses to apply. */
  problems: string[];
}

function repoActions(slug: string, oldOrg: string, r: RepoState): ReconcileAction[] {
  if (r.atNewOrgNewName) return [];
  if (r.atNewOrgOldName) {
    return [{ kind: "rename-repo", owner: slug, from: r.oldName, to: r.newName }];
  }
  if (r.atOldOrgOldName) {
    return [
      { kind: "transfer-repo", fromOwner: oldOrg, repo: r.oldName, toOwner: slug },
      { kind: "rename-repo", owner: slug, from: r.oldName, to: r.newName },
    ];
  }
  return [];
}

export function planGiteaReconcile(state: ReconcileState): ReconcilePlan {
  const { slug, oldOrg } = state;
  const problems: string[] = [];

  for (const r of state.repos) {
    if (!r.atOldOrgOldName && !r.atNewOrgOldName && !r.atNewOrgNewName) {
      problems.push(
        `${r.kind} repo "${r.oldName}" not found at ${oldOrg}/${r.oldName}, ${slug}/${r.oldName}, or ${slug}/${r.newName}`,
      );
    }
  }

  const repoWork = state.repos.flatMap((r) => repoActions(slug, oldOrg, r));
  const allReposDone = state.repos.every((r) => r.atNewOrgNewName);
  // builder user / team / membership is NOT a reconcile concern — the
  // post-#970 gateway mount self-heals it. "Done" = data moved.
  const fullyMigrated =
    problems.length === 0 &&
    state.orgExists &&
    !state.firestoreStale &&
    allReposDone;

  if (fullyMigrated) return { actions: [], problems: [] };

  const actions: ReconcileAction[] = [
    { kind: "ensure-org", slug },
    ...repoWork,
    ...(state.firestoreStale
      ? [{ kind: "firestore-repoint", slug } as ReconcileAction]
      : []),
  ];
  return { actions, problems };
}
