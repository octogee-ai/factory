

import type { ManagedChannelHost } from "@octogee/core/channel-host";
import type { ManagedGitHost } from "@octogee/core/git-host";
import { PROJECT_AGENT_REPO } from "@octogee/shared/types/project";

export interface NukeCloudCtx {
  uid: string;
  currentOperationId: string;
  slug: string;
  email: string | null;

  repoNames: string[];

projectSlugs: string[];

  workspaceTeamId: string | null;

  mmUserId: string | null;

  mmCoachUserId: string | null;

  adminChannelId: string | null;
  credentialSecretNames: string[];
  projectAgentMmUserIds: string[];
  projectAgentCredentialDocPaths: string[];
  chatArtifactIds: string[];
  agentImportIds: string[];

  skipHosting?: boolean;

  skipAuth?: boolean;
}

export type NukeCloudStepKey =
  | "gitea"
  | "mattermost"
  | "storage"
  | "hosting"
  | "credentials"
  | "computer"
  | "computer-home"
  | "firestore"
  | "auth";

export interface NukeCloudStepResult {
  key: NukeCloudStepKey;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  detail?: string;
}

export interface NukeCloudDeps {
  git: Pick<ManagedGitHost, "eraseOwner">;
  channels: Pick<ManagedChannelHost, "erase">;

  nukeUserFirestore: (
    uid: string,
    slug: string,
    email: string | null,
    currentOperationId: string,
  ) => Promise<void>;

  deleteUserStorage: (
    uid: string,
    slug: string,
    chatArtifactIds: string[],
    agentImportIds: string[],
  ) => Promise<void>;

  deleteCredentialSecrets: (secretNames: string[]) => Promise<void>;

deleteAuthUser: (uid: string) => Promise<void>;

deleteHostingSites?: (slug: string, projectSlugs: string[]) => Promise<{ deleted: number }>;

  deleteVm?: (uid: string) => Promise<boolean>;
  deleteVmHome: (uid: string, slug: string) => Promise<{ deleted: number }>;
  log?: (msg: string) => void;
}

export async function nukeUserCloudSide(
  ctx: NukeCloudCtx,
  deps: NukeCloudDeps,
): Promise<NukeCloudStepResult[]> {
  const log = deps.log ?? (() => undefined);
  const results: NukeCloudStepResult[] = [];

if (!ctx.slug) {
  results.push({ key: "gitea", ok: true, skipped: true });
} else {
  results.push(
    await runStep("gitea", log, async () => {
      await deps.git.eraseOwner(ctx.slug, [...ctx.repoNames, PROJECT_AGENT_REPO]);
    }),
  );
}

results.push(
    await runStep("mattermost", log, async () => {
      await deps.channels.erase({
        teamId: ctx.workspaceTeamId,
        ownerUserId: ctx.mmUserId,
        channelIds: ctx.adminChannelId ? [ctx.adminChannelId] : [],
        userIds: [
          ...(ctx.mmCoachUserId ? [ctx.mmCoachUserId] : []),
          ...ctx.projectAgentMmUserIds,
        ],
      });
    }),
  );

results.push(
    await runStep("storage", log, async () => {
      await deps.deleteUserStorage(
        ctx.uid,
        ctx.slug,
        ctx.chatArtifactIds,
        ctx.agentImportIds,
      );
    }),
  );

if (ctx.skipHosting || !deps.deleteHostingSites || !ctx.slug) {
    results.push({ key: "hosting", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("hosting", log, async () => {
        await deps.deleteHostingSites!(ctx.slug, ctx.projectSlugs);
      }),
    );
  }

  results.push(
    await runStep("credentials", log, async () => {
      await deps.deleteCredentialSecrets(ctx.credentialSecretNames);
    }),
  );

  if (deps.deleteVm) {
    const deleteVm = deps.deleteVm;
    results.push(
      await runStep("computer", log, async () => {
        await deleteVm(ctx.uid);
      }),
    );
  } else {
    results.push({ key: "computer", ok: true, skipped: true });
  }

  if (!ctx.slug) {
    results.push({ key: "computer-home", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("computer-home", log, async () => {
        const { deleted } = await deps.deleteVmHome(ctx.uid, ctx.slug);
        return `${deleted} ${deleted === 1 ? "object" : "objects"}`;
      }),
    );
  }

  const anchoredCleanupFailed = results.some((result) => ["hosting", "computer", "computer-home"].includes(result.key) && !result.ok);
  if (anchoredCleanupFailed) {
    results.push({ key: "firestore", ok: true, skipped: true });
  } else {
    results.push(
      await runStep("firestore", log, async () => {
        await deps.nukeUserFirestore(ctx.uid, ctx.slug, ctx.email, ctx.currentOperationId);
      }),
    );
  }

const earlierFailure = results.some((result) => !result.ok && !result.skipped);
if (ctx.skipAuth || earlierFailure) {
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
  body: () => Promise<string | void>,
): Promise<NukeCloudStepResult> {
  try {
    const detail = await body();
    log(detail ? `[nuke-cloud] step ${key} ✅ ${detail}` : `[nuke-cloud] step ${key} ✅`);
    return detail ? { key, ok: true, detail } : { key, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[nuke-cloud] step ${key} ⚠ ${message}`);
    return { key, ok: false, error: message };
  }
}
