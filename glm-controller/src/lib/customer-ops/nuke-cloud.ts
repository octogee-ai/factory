// Cloud-side nuke orchestrator — runs steps 3..8 + step 9 bookkeeping
// from the historical scripts/lib/nukeSteps.ts on behalf of the
// deprovision-customer op handler. Lives in glm-controller so the
// orphan path (no live gateway) works without any pod RPC.
//
// Local-fs steps 1..2 (agents + workspace dir) are not here — they
// belong to the gateway-side unmount handler, called by the
// deprovision-customer handler when the customer is currently mounted.

import type { GiteaCleanupClient } from "./gitea.js";
import type { MmCleanupClient } from "./mattermost.js";

export interface NukeCloudCtx {
  uid: string;
  slug: string;
  email: string | null;
  giteaOrg: string;
  /** workspace + per-project repo names: <slug>-workspace, <slug>-<projectSlug>... */
  repoNames: string[];
  /** workspace MM team — null when team-per-workspace doesn't apply (legacy fallback). */
  workspaceTeamId: string | null;
  /** Builder MM userId — null when never had one (raw signup with slug but no MM bootstrap). */
  mmUserId: string | null;
  /** Coach MM userId — null when no agent doc. */
  mmCoachUserId: string | null;
  /** workspaces/{slug}/channels/admin → MM channelId — null when missing. */
  adminChannelId: string | null;
  /** Skip Firebase Hosting site deletion (TEST builds without hosting). */
  skipHosting?: boolean;
  /** Skip Firebase Auth user deletion (e.g. operator wants to preserve the auth identity). */
  skipAuth?: boolean;
}

export type NukeCloudStepKey =
  | "gitea"
  | "mattermost"
  | "firestore"
  | "storage"
  | "hosting"
  | "auth";

export interface NukeCloudStepResult {
  key: NukeCloudStepKey;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export interface NukeCloudDeps {
  gitea: GiteaCleanupClient;
  mattermost: MmCleanupClient;
  /** Recursive-delete users/{uid}/* + customerStats/{uid} + the user doc. */
  nukeUserFirestore: (uid: string) => Promise<void>;
  /** Bulk-delete wsTickets where uid == ctx.uid. Returns count. */
  nukeWsTickets: (uid: string) => Promise<{ deleted: number }>;
  /** Delete avatars/{uid} from Firebase Storage (idempotent). */
  deleteAvatar: (uid: string) => Promise<void>;
  /**
   * Delete Firebase Auth account for uid. Implementations should swallow
   * `auth/user-not-found` (the common idempotent case).
   */
  deleteAuthUser: (uid: string) => Promise<void>;
  /**
   * Delete Firebase Hosting sites (octogee-{slug}, octogee-{slug}-{proj}…).
   * Returns the count of sites successfully deleted. Errors per-site are
   * logged but don't fail the step. Optional — pass undefined to skip.
   */
  deleteHostingSites?: (slug: string, projectSlugs: string[]) => Promise<{ deleted: number }>;
  log?: (msg: string) => void;
}

export async function nukeUserCloudSide(
  ctx: NukeCloudCtx,
  deps: NukeCloudDeps,
): Promise<NukeCloudStepResult[]> {
  const log = deps.log ?? (() => undefined);
  const results: NukeCloudStepResult[] = [];

  // Step 3: Gitea — repos + per-customer Gitea user
  results.push(
    await runStep("gitea", log, async () => {
      for (const repoName of ctx.repoNames) {
        await deps.gitea.deleteRepo(ctx.giteaOrg, repoName);
      }
      await deps.gitea.deleteGiteaUser(ctx.slug);
    }),
  );

  // Step 4: Mattermost — channels, builder user, coach user, workspace team
  results.push(
    await runStep("mattermost", log, async () => {
      if (ctx.mmUserId && ctx.workspaceTeamId) {
        const channelIds = await deps.mattermost.getUserChannels(
          ctx.mmUserId,
          ctx.workspaceTeamId,
        );
        for (const id of channelIds) {
          await deps.mattermost.destroyChannel(id);
        }
        await deps.mattermost.destroyUser(ctx.mmUserId);
      }
      if (ctx.adminChannelId) {
        await deps.mattermost.destroyChannel(ctx.adminChannelId);
      }
      if (ctx.mmCoachUserId) {
        await deps.mattermost.destroyUser(ctx.mmCoachUserId);
      }
      if (ctx.workspaceTeamId) {
        await deps.mattermost.destroyTeam(ctx.workspaceTeamId);
      }
    }),
  );

  // Step 5: Firestore — user subtrees, wsTickets
  results.push(
    await runStep("firestore", log, async () => {
      await deps.nukeUserFirestore(ctx.uid);
      await deps.nukeWsTickets(ctx.uid);
    }),
  );

  // Step 6: Storage avatar
  results.push(
    await runStep("storage", log, async () => {
      await deps.deleteAvatar(ctx.uid);
    }),
  );

  // Step 7: Firebase Hosting (optional / skippable)
  if (ctx.skipHosting || !deps.deleteHostingSites) {
    results.push({ key: "hosting", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("hosting", log, async () => {
        const projectSlugs = ctx.repoNames
          .filter((n) => n.startsWith(`${ctx.slug}-`) && n !== `${ctx.slug}-workspace`)
          .map((n) => n.slice(ctx.slug.length + 1));
        await deps.deleteHostingSites!(ctx.slug, projectSlugs);
      }),
    );
  }

  // Step 8: Firebase Auth account
  if (ctx.skipAuth) {
    results.push({ key: "auth", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("auth", log, async () => {
        await deps.deleteAuthUser(ctx.uid);
      }),
    );
  }

  return results;
}

async function runStep(
  key: NukeCloudStepKey,
  log: (msg: string) => void,
  body: () => Promise<void>,
): Promise<NukeCloudStepResult> {
  try {
    await body();
    log(`[nuke-cloud] step ${key} ✅`);
    return { key, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[nuke-cloud] step ${key} ⚠ ${message}`);
    return { key, ok: false, error: message };
  }
}
