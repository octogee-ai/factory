export const BUILDER_PAT_DESCRIPTION = "Octogee workspace chat";

export interface BuilderPatRotateDeps {
  mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
  writeBuilderSecret: (uid: string, data: { personalToken: string; rotatedAt: unknown }) => Promise<void>;
  now: () => unknown;
  log?: (msg: string) => void;
}

export interface BuilderPatRotateResult {
  outcome: 'rotated' | 'mm-user-missing' | 'mint-failed';
  newTokenLastFour?: string;
  revokedTokenIds?: string[];
}

interface MmTokenInfo {
  id?: unknown;
  description?: unknown;
}

export async function revokeAndMintBuilderPat(
  deps: BuilderPatRotateDeps,
  uid: string,
  builderMmUserId: string,
): Promise<BuilderPatRotateResult> {
  const log = deps.log ?? (() => {});
  if (!builderMmUserId) {
    return { outcome: 'mm-user-missing' };
  }

  const revokedTokenIds = await revokeStaleBuilderTokens(deps, builderMmUserId);

  let mintResult: unknown;
  try {
    mintResult = await deps.mmApiCall(
      'POST',
      `/users/${builderMmUserId}/tokens`,
      { description: BUILDER_PAT_DESCRIPTION },
    );
  } catch (err) {
    log(
      `[builder-pat] mint failed for ${builderMmUserId}: ${
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

  await deps.writeBuilderSecret(uid, { personalToken: token, rotatedAt: deps.now() });

  return {
    outcome: 'rotated',
    newTokenLastFour: token.slice(-4),
    revokedTokenIds,
  };
}

async function revokeStaleBuilderTokens(
  deps: BuilderPatRotateDeps,
  builderMmUserId: string,
): Promise<string[]> {
  const log = deps.log ?? (() => {});
  let listed: unknown;
  try {
    listed = await deps.mmApiCall('GET', `/users/${builderMmUserId}/tokens`);
  } catch (err) {
    log(
      `[builder-pat] list tokens failed for ${builderMmUserId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const stale = (listed as MmTokenInfo[]).filter(
    (t) => t?.description === BUILDER_PAT_DESCRIPTION && typeof t?.id === 'string',
  );
  const revoked: string[] = [];
  for (const t of stale) {
    const tokenId = t.id as string;
    try {
      await deps.mmApiCall('POST', '/users/tokens/revoke', { token_id: tokenId });
      revoked.push(tokenId);
    } catch (err) {
      log(
        `[builder-pat] revoke ${tokenId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return revoked;
}
