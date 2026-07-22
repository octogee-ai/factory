

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  deploymentEnvironmentSettings,
  deploymentSettingsForRuntime,
} from "@octogee/core/deployment-environment";
import {
  planGiteaReconcile,
  type ReconcileAction,
  type ReconcileState,
  type RepoState,
} from "../lib/gitea-reconcile.js";

const ENVS = new Set(["test", "prod"]);
const SAFE_SLUG = /^[a-z0-9-]+$/;
const OLD_ORG = "octogee";
const USAGE =
  "Usage: tsx scripts/ops/reconcile-gitea-org.ts --env=test|prod --slug=<slug> [--apply]";

export interface ReconcileArgs {
  env: "test" | "prod";
  slug: string;
  apply: boolean;
}

export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  let env = "";
  let slug = "";
  let apply = false;
  for (const a of argv) {
    if (a.startsWith("--env=")) env = a.slice("--env=".length);
    else if (a.startsWith("--slug=")) slug = a.slice("--slug=".length);
    else if (a === "--apply") apply = true;
    else throw new Error(`Unknown arg: ${a}\n${USAGE}`);
  }
  if (!ENVS.has(env)) {
    throw new Error(`--env must be test|prod (got: '${env}')\n${USAGE}`);
  }
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`--slug must match [a-z0-9-]+ (got: '${slug}')\n${USAGE}`);
  }
  return { env: env as "test" | "prod", slug, apply };
}

export function rewriteRepoUrl(
  oldUrl: string,
  oldOwner: string,
  oldRepo: string,
  newOwner: string,
  newRepo: string,
): string {
  for (const sep of ["/", ":"]) {
    const from = `${sep}${oldOwner}/${oldRepo}`;
    const i = oldUrl.lastIndexOf(from);
    if (i !== -1) {
      return (
        oldUrl.slice(0, i) +
        `${sep}${newOwner}/${newRepo}` +
        oldUrl.slice(i + from.length)
      );
    }
  }
  return oldUrl; 
}

export function resolveReconcileFirebaseProject(
  environment: "test" | "prod",
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): string {
  const target = deploymentSettingsForRuntime({
    namespace: runtimeEnv.K8S_NAMESPACE ?? deploymentEnvironmentSettings(environment).namespace,
    targetId: runtimeEnv.DEPLOYMENT_TARGET_ID,
  });
  if (target.name !== environment) {
    throw new Error(
      `Deployment target ${target.targetId} belongs to ${target.name}, not ${environment}`,
    );
  }
  return target.firebaseProjectId;
}

interface GiteaIO {
  api: string;
  headers: Record<string, string>;
}

function giteaIO(): GiteaIO {
  const api = (process.env.GITEA_API_URL ?? "").replace(/\/$/, "");
  const token = process.env.GITEA_ADMIN_TOKEN ?? "";
  if (!api || !token) {
    throw new Error(
      "GITEA_API_URL (…/api/v1) and GITEA_ADMIN_TOKEN env vars are required",
    );
  }
  return {
    api,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
}

async function exists(io: GiteaIO, path: string): Promise<boolean> {
  const r = await fetch(`${io.api}${path}`, { headers: io.headers });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`Gitea GET ${path} → ${r.status}`);
  return true;
}

interface ProjEntry {
  projectSlug: string;
  oldName: string;
}
interface Ctx {
  db: Firestore;
  slug: string;
  io: GiteaIO;
  wsGitea: { orgName?: string; repoName?: string };
  wsOldName: string;
  ownerUid: string;
  repoUrl: string;
  projects: ProjEntry[];
}

async function gatherCtx(
  db: Firestore,
  slug: string,
  io: GiteaIO,
): Promise<Ctx> {
  const wsSnap = await db.collection("workspaces").doc(slug).get();
  const ws = (wsSnap.data() ?? {}) as {
    ownerUid?: string;
    gitea?: { orgName?: string; repoName?: string };
  };
  const wsGitea = ws.gitea ?? {};
  const wsOldName =
    wsGitea.repoName && wsGitea.repoName !== "workspace"
      ? wsGitea.repoName
      : `${slug}-workspace`;
  const projSnap = await db
    .collection("workspaces")
    .doc(slug)
    .collection("projects")
    .get();
  const projects: ProjEntry[] = projSnap.docs.map((d) => {
    const data = d.data() as { slug?: string; giteaRepoName?: string };
    const projectSlug = data.slug ?? d.id;
    return {
      projectSlug,
      oldName: data.giteaRepoName ?? `${slug}-${projectSlug}`,
    };
  });
  const ownerUid = ws.ownerUid ?? "";
  const userSnap = ownerUid
    ? await db.collection("users").doc(ownerUid).get()
    : null;
  const repoUrl = (userSnap?.data()?.provisioning?.git?.repoUrl ??
    "") as string;
  return { db, slug, io, wsGitea, wsOldName, ownerUid, repoUrl, projects };
}

async function loadState(ctx: Ctx): Promise<ReconcileState> {
  const { slug, io } = ctx;
  const repoState = async (
    kind: RepoState["kind"],
    oldName: string,
    newName: string,
    projectSlug?: string,
  ): Promise<RepoState> => ({
    kind,
    projectSlug,
    oldName,
    newName,
    atOldOrgOldName: await exists(io, `/repos/${OLD_ORG}/${oldName}`),
    atNewOrgOldName: await exists(io, `/repos/${slug}/${oldName}`),
    atNewOrgNewName: await exists(io, `/repos/${slug}/${newName}`),
  });
  const repos: RepoState[] = [
    await repoState("workspace", ctx.wsOldName, "workspace"),
    ...(await Promise.all(
      ctx.projects.map((p) =>
        repoState("project", p.oldName, p.projectSlug, p.projectSlug),
      ),
    )),
  ];
  const firestoreStale =
    ctx.wsGitea.orgName !== slug ||
    ctx.wsGitea.repoName !== "workspace" ||

!ctx.repoUrl.includes(`${slug}/workspace`) ||
    ctx.projects.some((p) => p.oldName !== p.projectSlug);
  return {
    slug,
    oldOrg: OLD_ORG,
    orgExists: await exists(io, `/orgs/${slug}`),
    firestoreStale,
    repos,
  };
}

interface GiteaWrite {
  path: string;
  method: string;
  body: unknown;
  
  okStatuses?: number[];
  label: string;
}

async function giteaWrite(io: GiteaIO, w: GiteaWrite): Promise<void> {
  const r = await fetch(`${io.api}${w.path}`, {
    method: w.method,
    headers: io.headers,
    body: JSON.stringify(w.body),
  });
  if (!r.ok && !(w.okStatuses ?? []).includes(r.status)) {
    throw new Error(`${w.label}: ${r.status} ${await r.text()}`);
  }
  console.info(`  ✓ ${w.label}`);
}

async function repointFirestore(ctx: Ctx): Promise<void> {
  const { db, slug } = ctx;
  await db
    .collection("workspaces")
    .doc(slug)
    .set({ gitea: { orgName: slug, repoName: "workspace" } }, { merge: true });
  const newRepoUrl = rewriteRepoUrl(
    ctx.repoUrl,
    OLD_ORG,
    ctx.wsOldName,
    slug,
    "workspace",
  );
  if (ctx.ownerUid && newRepoUrl) {
    await db
      .collection("users")
      .doc(ctx.ownerUid)
      .set(
        { provisioning: { git: { repoUrl: newRepoUrl } } },
        { merge: true },
      );
  }
  for (const p of ctx.projects) {
    await db
      .collection("workspaces")
      .doc(slug)
      .collection("projects")
      .doc(p.projectSlug)
      .set({ giteaRepoName: p.projectSlug }, { merge: true });
  }
  console.info(`  ✓ Firestore .git re-pointed for ${slug}`);
}

async function applyAction(action: ReconcileAction, ctx: Ctx): Promise<void> {
  const { io, slug } = ctx;
  if (action.kind === "ensure-org") {
    await giteaWrite(io, {
      path: `/orgs`,
      method: "POST",
      body: { username: slug, visibility: "private" },
      okStatuses: [422],
      label: `org ensured: ${slug}`,
    });
  } else if (action.kind === "transfer-repo") {
    await giteaWrite(io, {
      path: `/repos/${action.fromOwner}/${action.repo}/transfer`,
      method: "POST",
      body: { new_owner: action.toOwner },
      label: `transferred ${action.fromOwner}/${action.repo} → ${action.toOwner}`,
    });
  } else if (action.kind === "rename-repo") {
    await giteaWrite(io, {
      path: `/repos/${action.owner}/${action.from}`,
      method: "PATCH",
      body: { name: action.to },
      label: `renamed ${action.owner}/${action.from} → ${action.to}`,
    });
  } else {
    await repointFirestore(ctx);
  }
}

function printPlan(slug: string, env: string, plan: ReturnType<typeof planGiteaReconcile>): void {
  console.info(`\n=== Gitea reconcile plan for "${slug}" (${env}) ===`);
  for (const a of plan.actions) console.info("  •", JSON.stringify(a));
  if (plan.actions.length === 0) {
    console.info("  (already reconciled — no actions)");
  }
}

async function main(): Promise<void> {
  const args = parseReconcileArgs(process.argv.slice(2));
  const io = giteaIO();
  initializeApp({
    credential: applicationDefault(),
    projectId: resolveReconcileFirebaseProject(args.env),
  });
  const db = getFirestore();

  const ctx = await gatherCtx(db, args.slug, io);
  const plan = planGiteaReconcile(await loadState(ctx));
  printPlan(args.slug, args.env, plan);
  if (plan.problems.length > 0) {
    for (const p of plan.problems) console.error("  ✗ PROBLEM:", p);
    throw new Error(
      `Refusing to proceed — ${plan.problems.length} problem(s); resolve and re-run.`,
    );
  }
  if (!args.apply) {
    console.info("\nDRY RUN — no changes. Re-run with --apply to execute.\n");
    return;
  }

  for (const action of plan.actions) await applyAction(action, ctx);

const verify = planGiteaReconcile(await loadState(await gatherCtx(db, args.slug, io)));
  if (verify.actions.length > 0 || verify.problems.length > 0) {
    throw new Error(
      `Post-apply verify FAILED: ${JSON.stringify(verify)}`,
    );
  }
  console.info(
    `\n✓ Reconcile complete + verified for "${args.slug}". Restart the gateway to self-heal ws-${args.slug} access (#970).\n`,
  );
}

const invokedDirectly =
  process.argv[1]?.endsWith("reconcile-gitea-org.ts") ||
  process.argv[1]?.endsWith("reconcile-gitea-org.js");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[reconcile-gitea-org] ${err.message}`);
    process.exit(1);
  });
}
