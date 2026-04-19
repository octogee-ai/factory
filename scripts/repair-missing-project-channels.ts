/**
 * One-shot repair: backfill missing `channels/general` subdocs (and their
 * matching Mattermost channels) for projects that were created before the
 * hard-failure fix in docs/PROJECTS-CANVAS-SPEC.md §D4.
 *
 * Before the fix, the create handler's MM channel `try/catch` silently
 * warned and returned `{success: true}` even when no MM channel was ever
 * created. The result is projects in Firestore with
 * `provisioningState: 'active'` but no `channels/general` subcollection.
 *
 * This script finds them, creates the MM channel (or looks up an existing
 * one by name), writes the subdoc, and clears any lingering
 * `provisioningError`. Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=~/.openclaw/secrets/octogee-test-sa-key.json \
 *   MM_URL=https://chat-test.octogee.com \
 *   MM_ADMIN_TOKEN=<admin-token> \
 *   npx tsx scripts/repair-missing-project-channels.ts [--apply]
 *
 * Default mode is dry-run. Pass --apply to actually write to Firestore + MM.
 */

import * as admin from "firebase-admin";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { projectGeneralChannelName } from "../shared/types/identity.js";

const APPLY = process.argv.includes("--apply");
const SA_KEY = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(os.homedir(), ".openclaw", "secrets", "octogee-test-sa-key.json");
const MM_URL = process.env.MM_URL;
const MM_ADMIN_TOKEN = process.env.MM_ADMIN_TOKEN;

if (!MM_URL || !MM_ADMIN_TOKEN) {
  console.error("ERROR: Both MM_URL and MM_ADMIN_TOKEN must be set.");
  process.exit(1);
}

const saKey = JSON.parse(fs.readFileSync(SA_KEY, "utf-8"));
admin.initializeApp({
  credential: admin.credential.cert(saKey),
  projectId: saKey.project_id,
});
const db = admin.firestore();

async function mm(method: string, endpoint: string, body?: unknown): Promise<any> {
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
    (err as any).status = resp.status;
    throw err;
  }
  return resp.json();
}

interface ProjectToRepair {
  workspaceId: string;
  projectSlug: string;
  projectName: string;
  teamId: string;
  /**
   * Target visibility to apply on success. If the doc has `pendingVisibility`,
   * use it (hard-fail retry flow). Otherwise preserve the current
   * `visibility` (legacy dannyboy-TEST shape — created before §D4 existed,
   * current visibility IS the user's intent).
   */
  targetVisibility: string | null;
  /** Current giteaRepoName, or null if the doc predates the up-front write. */
  giteaRepoName: string | null;
}

async function findProjectsNeedingRepair(): Promise<ProjectToRepair[]> {
  const snap = await db.collectionGroup("projects").get();
  const out: ProjectToRepair[] = [];

  for (const doc of snap.docs) {
    // Skip docs that aren't at workspaces/{wid}/projects/{pid} depth.
    const segments = doc.ref.path.split("/");
    if (segments.length !== 4 || segments[0] !== "workspaces" || segments[2] !== "projects") continue;

    const general = await doc.ref.collection("channels").doc("general").get();
    if (general.exists) continue;

    const data = doc.data();
    const workspaceId = segments[1];
    const projectSlug = segments[3];

    const wsSnap = await db.doc(`workspaces/${workspaceId}`).get();
    const teamId = wsSnap.data()?.mattermost?.teamId;
    if (!teamId) {
      console.warn(`  SKIP ${workspaceId}/${projectSlug} — workspace has no MM teamId`);
      continue;
    }

    out.push({
      workspaceId,
      projectSlug,
      projectName: data.name || projectSlug,
      teamId,
      targetVisibility:
        typeof data.pendingVisibility === "string" ? data.pendingVisibility : (data.visibility ?? null),
      giteaRepoName: data.giteaRepoName ?? null,
    });
  }
  return out;
}

async function repairOne(p: ProjectToRepair): Promise<void> {
  const channelName = projectGeneralChannelName(p.workspaceId, p.projectSlug);

  let channelId: string;
  try {
    const existing = await mm("GET", `/teams/${p.teamId}/channels/name/${channelName}`);
    channelId = existing.id;
    console.log(`  FOUND existing MM channel ${channelName} (${channelId})`);
  } catch (err: any) {
    if (err.status !== 404) throw err;
    if (!APPLY) {
      console.log(`  [DRY] would CREATE MM channel ${channelName}`);
      return;
    }
    const created = await mm("POST", "/channels", {
      team_id: p.teamId,
      name: channelName,
      display_name: p.projectName,
      type: "O",
    });
    channelId = created.id;
    console.log(`  CREATED MM channel ${channelName} (${channelId})`);
  }

  if (!APPLY) {
    console.log(`  [DRY] would write channels/general subdoc for ${p.workspaceId}/${p.projectSlug}`);
    return;
  }

  const projectRef = db.doc(`workspaces/${p.workspaceId}/projects/${p.projectSlug}`);
  await projectRef.collection("channels").doc("general").set({
    id: "general",
    kind: "general",
    name: "general",
    mattermost: { channelId },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const updates: Record<string, unknown> = {
    provisioningState: "active",
    provisioningError: null,
    pendingVisibility: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (p.targetVisibility) updates.visibility = p.targetVisibility;
  if (!p.giteaRepoName) updates.giteaRepoName = `${p.workspaceId}-proj-${p.projectSlug}`;
  await projectRef.update(updates);
  console.log(`  WROTE channels/general for ${p.workspaceId}/${p.projectSlug}`);
}

async function main() {
  console.log(`Project: ${saKey.project_id}${APPLY ? "" : " [DRY RUN — pass --apply to write]"}`);

  const needs = await findProjectsNeedingRepair();
  console.log(`Found ${needs.length} project(s) missing channels/general:`);
  for (const p of needs) {
    console.log(`  - ${p.workspaceId}/${p.projectSlug}  (${p.projectName})`);
  }

  for (const p of needs) {
    try {
      await repairOne(p);
    } catch (err: any) {
      console.error(`  FAILED ${p.workspaceId}/${p.projectSlug}: ${err.message}`);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
