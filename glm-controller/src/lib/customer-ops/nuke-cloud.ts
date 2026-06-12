

import type { GiteaCleanupClient } from "./gitea.js";
import type { MmCleanupClient } from "./mattermost.js";

export interface NukeCloudCtx {
  uid: string;
  slug: string;
  email: string | null;
  giteaOrg: string;
  
  repoNames: string[];

projectSlugs: string[];
  
  workspaceTeamId: string | null;
  
  mmUserId: string | null;
  
  mmCoachUserId: string | null;
  
  adminChannelId: string | null;
  
  skipHosting?: boolean;
  
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

  nukeUserFirestore: (uid: string, slug: string) => Promise<void>;

  deleteAvatar: (uid: string) => Promise<void>;

deleteAuthUser: (uid: string) => Promise<void>;

deleteHostingSites?: (slug: string, projectSlugs: string[]) => Promise<{ deleted: number }>;
  log?: (msg: string) => void;
}

export async function nukeUserCloudSide(
  ctx: NukeCloudCtx,
  deps: NukeCloudDeps,
): Promise<NukeCloudStepResult[]> {
  const log = deps.log ?? (() => undefined);
  const results: NukeCloudStepResult[] = [];

results.push(
    await runStep("gitea", log, async () => {
      for (const repoName of ctx.repoNames) {
        await deps.gitea.deleteRepo(ctx.giteaOrg, repoName);
      }
      await deps.gitea.deleteOrg(ctx.giteaOrg);
      await deps.gitea.deleteGiteaUser(ctx.slug);
    }),
  );

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

results.push(
    await runStep("firestore", log, async () => {
      await deps.nukeUserFirestore(ctx.uid, ctx.slug);
    }),
  );

results.push(
    await runStep("storage", log, async () => {
      await deps.deleteAvatar(ctx.uid);
    }),
  );

if (ctx.skipHosting || !deps.deleteHostingSites) {
    results.push({ key: "hosting", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("hosting", log, async () => {
        await deps.deleteHostingSites!(ctx.slug, ctx.projectSlugs);
      }),
    );
  }

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
