

import { getFirestore } from "firebase-admin/firestore";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { operatorPlatformStateStoreForFirebaseProject } from "../lib/platform-state-store.js";
import { projectGeneralChannelName } from "../../shared/types/identity.js";
import { pathToFileURL } from "node:url";
import { initializeOperatorFirebaseAdmin } from "../lib/operator-firebase-admin.js";

export interface RepairMissingProjectChannelsConfig {
  apply: boolean;
  mmAdminToken: string | undefined;
  mmUrl: string | undefined;
  project: string;
}

export function resolveRepairMissingProjectChannelsConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): RepairMissingProjectChannelsConfig {
  const projectFlag = argv.find((arg) => arg.startsWith("--project="));
  return {
    apply: argv.includes("--apply"),
    project: projectFlag ? projectFlag.slice("--project=".length) : "octogee-test",
    mmUrl: env.MM_URL,
    mmAdminToken: env.MM_ADMIN_TOKEN,
  };
}

let APPLY = false;
let MM_URL = "";
let MM_ADMIN_TOKEN = "";
let db: FirebaseFirestore.Firestore;
let store: PlatformStateStore;

async function mm(method: string, endpoint: string, body?: unknown): Promise<{ id: string; type: string }> {
  const resp = await fetch(`${MM_URL}/api/v4${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${MM_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`MM ${resp.status} ${method} ${endpoint}: ${text.slice(0, 200)}`);
    (err as { status?: number }).status = resp.status;
    throw err;
  }
  return resp.json();
}

interface ProjectToRepair {
  workspaceId: string;
  projectSlug: string;
  projectName: string;
  teamId: string;

ownerMmUserId: string;

agentMmUserId: string;

targetVisibility: string | null;
  
  giteaRepoName: string | null;
}

async function findProjectsNeedingRepair(): Promise<ProjectToRepair[]> {
  const out: ProjectToRepair[] = [];
  const ownerCache = new Map<string, { ownerMmUserId: string; agentMmUserId: string }>();
  const teamCache = new Map<string, string>();

  for (const project of await store.workspaces.projects.listAll()) {
    const { workspaceSlug: workspaceId, projectSlug, ownerUid } = project;
    const general = await store.workspaces.channels.get({ workspaceSlug: workspaceId, projectSlug }, "general");
    if (general !== null) continue;

    let teamId = teamCache.get(workspaceId);
    if (teamId === undefined) {
      teamId = (await store.workspaces.records.get(workspaceId))?.mattermostTeamId ?? "";
      teamCache.set(workspaceId, teamId);
    }
    if (!teamId) {
      console.warn(`  SKIP ${workspaceId}/${projectSlug} — workspace has no MM teamId`);
      continue;
    }

    let owner = ownerCache.get(ownerUid);
    if (owner === undefined) {
      const [builder, agent] = await Promise.all([
        store.builders.records.get(ownerUid),
        store.workspaces.agentIdentities.get(ownerUid),
      ]);
      owner = {
        ownerMmUserId: builder?.mattermostUserId ?? "",
        agentMmUserId: agent?.mattermostUserId ?? "",
      };
      ownerCache.set(ownerUid, owner);
    }

    const productDoc = await db.doc(`workspaces/${workspaceId}/projects/${projectSlug}`).get();
    out.push({
      workspaceId,
      projectSlug,
      projectName: (productDoc.data()?.name as string | undefined) || projectSlug,
      teamId,
      ...owner,
      targetVisibility: project.pendingVisibility ?? project.visibility,
      giteaRepoName: project.giteaRepoName,
    });
  }
  return out;
}

async function repairOne(p: ProjectToRepair): Promise<void> {
  const channelName = projectGeneralChannelName(p.workspaceId, p.projectSlug);

  let channelId: string;
  let existingType: string | undefined;
  try {
    const existing = await mm("GET", `/teams/${p.teamId}/channels/name/${channelName}`);
    channelId = existing.id;
    existingType = existing.type;
    console.log(`  FOUND existing MM channel ${channelName} (${channelId}, type=${existingType})`);
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) throw err;
    if (!APPLY) {
      console.log(`  [DRY] would CREATE MM channel ${channelName} (type=P)`);
      return;
    }

const created = await mm("POST", "/channels", {
      team_id: p.teamId,
      name: channelName,
      display_name: p.projectName,
      type: "P",
    });
    channelId = created.id;
    existingType = "P";
    console.log(`  CREATED MM channel ${channelName} (${channelId}, type=P)`);
  }

  if (!APPLY) {
    console.log(`  [DRY] would write channels/general subdoc for ${p.workspaceId}/${p.projectSlug}`);
    if (existingType === "O") console.log(`  [DRY] would convert ${channelName} O→P`);
    if (p.ownerMmUserId) console.log(`  [DRY] would add owner ${p.ownerMmUserId} as channel member`);
    if (p.agentMmUserId) console.log(`  [DRY] would add agent ${p.agentMmUserId} as channel member`);
    return;
  }

if (existingType === "O") {
    await mm("PUT", `/channels/${channelId}/privacy`, { privacy: "P" });
    console.log(`  CONVERTED ${channelName} O → P`);
  }

for (const m of [
    { id: p.ownerMmUserId, label: "owner" },
    { id: p.agentMmUserId, label: "agent" },
  ]) {
    if (!m.id) {
      throw new Error(
        `${m.label} has no Mattermost userId for ${p.workspaceId}/${p.projectSlug} — provisioning incomplete`,
      );
    }
    await mm("POST", `/channels/${channelId}/members`, { user_id: m.id });
    console.log(`  ENSURED ${m.label} ${m.id} in ${channelName}`);
  }

  await store.workspaces.channels.put({
    scope: { workspaceSlug: p.workspaceId, projectSlug: p.projectSlug },
    channelId: "general",
    kind: "general",
    mattermostChannelId: channelId,
    archivedAt: null,
    createdBy: null,
    createdAt: { serverNow: true },
  });
  await db.doc(`workspaces/${p.workspaceId}/projects/${p.projectSlug}/channels/general`)
    .set({ name: "general" }, { merge: true });
  await store.workspaces.projects.patch(p.workspaceId, p.projectSlug, {
    provisioningState: "active",
    provisioningError: null,
    pendingVisibility: null,
    updatedAt: { serverNow: true },
    ...(p.targetVisibility ? { visibility: p.targetVisibility } : {}),
    ...(p.giteaRepoName ? {} : { giteaRepoName: p.projectSlug }),
  });
  console.log(`  WROTE channels/general for ${p.workspaceId}/${p.projectSlug}`);
}

async function main() {
  const config = resolveRepairMissingProjectChannelsConfig(process.argv.slice(2));
  if (!config.mmUrl || !config.mmAdminToken) {
    console.error("ERROR: Both MM_URL and MM_ADMIN_TOKEN must be set.");
    process.exit(1);
  }
  APPLY = config.apply;
  MM_URL = config.mmUrl;
  MM_ADMIN_TOKEN = config.mmAdminToken;

  initializeOperatorFirebaseAdmin(config.project);
  db = getFirestore();
  store = await operatorPlatformStateStoreForFirebaseProject(db, config.project);
  console.log(`Project: ${config.project}${APPLY ? "" : " [DRY RUN — pass --apply to write]"}`);

  const needs = await findProjectsNeedingRepair();
  console.log(`Found ${needs.length} project(s) missing channels/general:`);
  for (const p of needs) {
    console.log(`  - ${p.workspaceId}/${p.projectSlug}  (${p.projectName})`);
  }

  for (const p of needs) {
    try {
      await repairOne(p);
    } catch (err: unknown) {
      console.error(`  FAILED ${p.workspaceId}/${p.projectSlug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("Done.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
