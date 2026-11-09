import type { ManagedChannelHost } from "../channel-host/types.js";
import type { SecretsRepository } from "../platform-state/secrets.js";

export const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";

export interface CoachPatMintDeps {
  channelHost: Pick<ManagedChannelHost, "revokeTokens" | "issueToken">;
  secrets: Pick<SecretsRepository, "put">;
}

export async function mintAndPersistCoachToken(
  deps: CoachPatMintDeps,
  uid: string,
  coachMmUserId: string,
): Promise<{ token: string } | null> {
  if (!coachMmUserId) return null;

  await deps.channelHost.revokeTokens(coachMmUserId, COACH_PAT_DESCRIPTION);
  let token: string | null;
  try {
    token = await deps.channelHost.issueToken(coachMmUserId, COACH_PAT_DESCRIPTION);
  } catch {
    return null;
  }
  if (!token) return null;
  await deps.secrets.put(uid, {
    kind: "coach-mattermost",
    secretId: "coachMattermost",
    projectId: null,
    personalToken: token,
    mattermostUserId: coachMmUserId,
    createdAt: { serverNow: true },
    rotatedAt: null,
  });
  return { token };
}
