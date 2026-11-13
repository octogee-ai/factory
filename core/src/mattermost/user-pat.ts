export const USER_PAT_DESCRIPTION = "Octogee workspace chat";

export interface UserPatRotateDeps {
  mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
  writeUserSecret: (uid: string, data: { personalToken: string; rotatedAt: unknown }) => Promise<void>;
  now: () => unknown;
  log?: (msg: string) => void;
}

export interface UserPatRotateResult {
  outcome: 'rotated' | 'mm-user-missing' | 'mint-failed';
  newTokenLastFour?: string;
  revokedTokenIds?: string[];
}

interface MmTokenInfo {
  id?: unknown;
  description?: unknown;
}

export async function revokeAndMintUserPat(
  deps: UserPatRotateDeps,
  uid: string,
  userMmUserId: string,
): Promise<UserPatRotateResult> {
  const log = deps.log ?? (() => {});
  if (!userMmUserId) {
    return { outcome: 'mm-user-missing' };
  }

  const revokedTokenIds = await revokeStaleUserTokens(deps, userMmUserId);

  let mintResult: unknown;
  try {
    mintResult = await deps.mmApiCall(
      'POST',
      `/users/${userMmUserId}/tokens`,
      { description: USER_PAT_DESCRIPTION },
    );
  } catch (err) {
    log(
      `[user-pat] mint failed for ${userMmUserId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { outcome: 'mint-failed', revokedTokenIds };
  }

  const token =
    mintResult && typeof mintResult === 'object' && typeof (mintResult as { token?: unknown }).token === 'string'
      ? (mintResult as { token: string }).token
      : '';
  if (!token) {
    return { outcome: 'mint-failed', revokedTokenIds };
  }

  await deps.writeUserSecret(uid, { personalToken: token, rotatedAt: deps.now() });

  return {
    outcome: 'rotated',
    newTokenLastFour: token.slice(-4),
    revokedTokenIds,
  };
}

async function revokeStaleUserTokens(
  deps: UserPatRotateDeps,
  userMmUserId: string,
): Promise<string[]> {
  const log = deps.log ?? (() => {});
  let listed: unknown;
  try {
    listed = await deps.mmApiCall('GET', `/users/${userMmUserId}/tokens`);
  } catch (err) {
    log(
      `[user-pat] list tokens failed for ${userMmUserId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const stale = (listed as MmTokenInfo[]).filter(
    (t) => t?.description === USER_PAT_DESCRIPTION && typeof t?.id === 'string',
  );
  const revoked: string[] = [];
  for (const t of stale) {
    const tokenId = t.id as string;
    try {
      await deps.mmApiCall('POST', '/users/tokens/revoke', { token_id: tokenId });
      revoked.push(tokenId);
    } catch (err) {
      log(
        `[user-pat] revoke ${tokenId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return revoked;
}
