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
  /** Owner's MM userId. Empty string when the user doc has no
   *  `mattermost.userId` yet — `repairOne()` hard-fails (throws) for
   *  this project so the sweep loop in `main()` logs it as FAILED and
   *  moves on. The owner membership add is required: a project channel
   *  without its owner is broken state, not a partial success. */
  ownerMmUserId: string;
  /** Agent (Octo) MM userId for the owner. Same hard-fail semantics as
   *  ownerMmUserId — the agent in the project channel is the whole
   *  point of the channel. */
  agentMmUserId: string;
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
  // Cache by ownerUid: many projects share an owner (one workspace owner
  // → all their projects). Without caching this loop did 2 extra reads
  // per project doc — Firestore N+1 + cost on a large sweep.
  const ownerCache = new Map<string, { ownerMmUserId: string; agentMmUserId: string }>();
  const teamCache = new Map<string, string>(); // workspaceId → teamId

  for (const doc of snap.docs) {
    // Skip docs that aren't at workspaces/{wid}/projects/{pid} depth.
    const segments = doc.ref.path.split("/");
    if (segments.length !== 4 || segments[0] !== "workspaces" || segments[2] !== "projects") continue;

    const general = await doc.ref.collection("channels").doc("general").get();
    if (general.exists) continue;

    const data = doc.data();
    const workspaceId = segments[1];
    const projectSlug = segments[3];

    // Explicit string typing — without it TS doesn't narrow `teamId`
    // back to string after the cache-miss assignment, since
    // wsSnap.data()?.mattermost?.teamId widens through `any` and
    // doesn't carry the narrowing through the union.
    let teamId: string;
    const cachedTeamId = teamCache.get(workspaceId);
    if (cachedTeamId !== undefined) {
      teamId = cachedTeamId;
    } else {
      const wsSnap = await db.doc(`workspaces/${workspaceId}`).get();
      teamId = (wsSnap.data()?.mattermost?.teamId ?? "") as string;
      teamCache.set(workspaceId, teamId);
    }
    if (!teamId) {
      console.warn(`  SKIP ${workspaceId}/${projectSlug} — workspace has no MM teamId`);
      continue;
    }

    // Project channels carry an Octo agent and must be private. Look up
    // the owner's MM userId + their agent's MM userId so we can add them
    // as channel members — without these adds, the owner can't see the
    // private channel in their sidebar and the agent can't post into it.
    const ownerUid = data.ownerUid as string | undefined;
    let ownerMmUserId = "";
    let agentMmUserId = "";
    if (ownerUid) {
      const cached = ownerCache.get(ownerUid);
      if (cached) {
        ownerMmUserId = cached.ownerMmUserId;
        agentMmUserId = cached.agentMmUserId;
      } else {
        const userSnap = await db.doc(`users/${ownerUid}`).get();
        ownerMmUserId = userSnap.data()?.mattermost?.userId ?? "";
        const agentSnap = await db.doc(`agents/${ownerUid}`).get();
        agentMmUserId = agentSnap.data()?.mattermost?.userId ?? "";
        ownerCache.set(ownerUid, { ownerMmUserId, agentMmUserId });
      }
    }

    out.push({
      workspaceId,
      projectSlug,
      projectName: data.name || projectSlug,
      teamId,
      ownerMmUserId,
      agentMmUserId,
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
  let existingType: string | undefined;
  try {
    const existing = await mm("GET", `/teams/${p.teamId}/channels/name/${channelName}`);
    channelId = existing.id;
    existingType = existing.type;
    console.log(`  FOUND existing MM channel ${channelName} (${channelId}, type=${existingType})`);
  } catch (err: any) {
    if (err.status !== 404) throw err;
    if (!APPLY) {
      console.log(`  [DRY] would CREATE MM channel ${channelName} (type=P)`);
      return;
    }
    // Project channels carry an Octo agent and must be private. The
    // canonical pattern lives in scripts/lib/mattermost/channels.ts —
    // mirroring it here keeps the repair output consistent with fresh
    // creates.
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

  // Convert legacy "O" channels to private. PUT is idempotent — P→P
  // returns 200 — so this is safe even if existingType detection drifts.
  // A failed conversion is a HARD failure: leaving an open channel
  // behind would leak agent activity to the whole team, violating the
  // "all project channels are private" invariant. Throw so the per-
  // project try/catch in main() logs this project as FAILED instead of
  // proceeding to write channels/general and mark it active.
  if (existingType === "O") {
    await mm("PUT", `/channels/${channelId}/privacy`, { privacy: "P" });
    console.log(`  CONVERTED ${channelName} O → P`);
  }

  // Ensure owner + agent are channel members. The agent in the project
  // channel is the whole point of the channel — without it OpenClaw
  // RPCs land in a void. Throw on missing IDs or add failures so the
  // sweep loop logs this project as FAILED rather than reporting
  // success on a half-fixed state. MM's POST /members is idempotent —
  // re-adding an existing member returns 200 with the existing
  // membership doc, so re-running the script is safe.
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
