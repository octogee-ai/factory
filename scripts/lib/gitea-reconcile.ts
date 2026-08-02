

export type ReconcileAction =
  | { kind: "ensure-org"; slug: string }
  | { kind: "ensure-system-config-repo"; slug: string }
  | { kind: "transfer-repo"; fromOwner: string; repo: string; toOwner: string }
  | { kind: "rename-repo"; owner: string; from: string; to: string }
  | { kind: "firestore-repoint"; slug: string };

export interface RepoState {
  kind: "workspace" | "project";
  projectSlug?: string;
  
  oldName: string;
  
  newName: string;
  
  atOldOrgOldName: boolean;
  
  atNewOrgOldName: boolean;
  
  atNewOrgNewName: boolean;
}

export interface ReconcileState {
  slug: string;
  
  oldOrg: string;
  orgExists: boolean;
  systemConfigRepoExists: boolean;

firestoreStale: boolean;
  
  repos: RepoState[];
}

export interface ReconcilePlan {
  actions: ReconcileAction[];
  
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

const fullyMigrated =
    problems.length === 0 &&
    state.orgExists &&
    state.systemConfigRepoExists &&
    !state.firestoreStale &&
    allReposDone;

  if (fullyMigrated) return { actions: [], problems: [] };

  const actions: ReconcileAction[] = [
    { kind: "ensure-org", slug },
    ...(!state.systemConfigRepoExists
      ? [{ kind: "ensure-system-config-repo", slug } as ReconcileAction]
      : []),
    ...repoWork,
    ...(state.firestoreStale
      ? [{ kind: "firestore-repoint", slug } as ReconcileAction]
      : []),
  ];
  return { actions, problems };
}
