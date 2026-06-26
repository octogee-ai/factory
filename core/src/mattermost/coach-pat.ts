export const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";

interface MintCollectionRef {
  doc(id: string): MintDocRef;
}
interface MintDocRef {
  collection(name: string): MintCollectionRef;
  set(data: Record<string, unknown>): Promise<unknown>;
}

interface MmToken {
  id?: string;
  description?: string;
}

export interface CoachPatMintDeps {
  mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
  db: { collection: (name: string) => MintCollectionRef };
  now: () => unknown;
  log?: (msg: string) => void;
}

async function revokeStaleCoachTokens(
  deps: CoachPatMintDeps,
  coachMmUserId: string,
): Promise<void> {
  const warn = deps.log ?? (() => {});
  let existing: unknown;
  try {
    existing = await deps.mmApiCall("GET", `/users/${coachMmUserId}/tokens`);
  } catch (err) {
    warn(
      `[mattermost] ⚠ list coach tokens failed for ${coachMmUserId} — proceeding with mint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!Array.isArray(existing) || existing.length === 0) return;
  const stale = (existing as MmToken[]).filter(
    (t) => t?.description === COACH_PAT_DESCRIPTION && typeof t?.id === "string",
  );
  for (const t of stale) {
    try {
      await deps.mmApiCall("POST", "/users/tokens/revoke", { token_id: t.id });
    } catch (err) {
      warn(
        `[mattermost] ⚠ revoke stale coach token ${t.id} failed — continuing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export async function mintAndPersistCoachToken(
  deps: CoachPatMintDeps,
  uid: string,
  coachMmUserId: string,
): Promise<{ token: string } | null> {
  if (!coachMmUserId) return null;

  await revokeStaleCoachTokens(deps, coachMmUserId);
  let result: unknown;
  try {
    result = await deps.mmApiCall("POST", `/users/${coachMmUserId}/tokens`, {
      description: COACH_PAT_DESCRIPTION,
    });
  } catch {
    return null;
  }
  const token = (result as { token?: unknown })?.token;
  if (typeof token !== "string" || !token) return null;
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
