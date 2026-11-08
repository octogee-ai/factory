import type { ManagedChannelHost } from "../channel-host/types.js";

export const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";

interface MintCollectionRef {
  doc(id: string): MintDocRef;
}
interface MintDocRef {
  collection(name: string): MintCollectionRef;
  set(data: Record<string, unknown>): Promise<unknown>;
}

export interface CoachPatMintDeps {
  channelHost: Pick<ManagedChannelHost, "revokeTokens" | "issueToken">;
  db: { collection: (name: string) => MintCollectionRef };
  now: () => unknown;
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
  await deps.db
    .collection("users").doc(uid)
    .collection("secrets").doc("coachMattermost")
    .set({
      personalToken: token,
      coachMmUserId,
      createdAt: deps.now(),
    });
  return { token };
}
