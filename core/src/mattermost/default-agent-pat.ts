import type { ManagedChannelHost } from "../channel-host/types.js";
import type { SecretsRepository } from "../platform-state/secrets.js";
import type { TimeInput } from "../platform-state/store.js";

export const DEFAULT_AGENT_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";

export interface DefaultAgentPatMintDeps {
  channelHost: Pick<ManagedChannelHost, "revokeTokens" | "issueToken">;
  secrets: Pick<SecretsRepository, "put">;
  now: () => TimeInput;
}

export async function mintAndPersistDefaultAgentToken(
  deps: DefaultAgentPatMintDeps,
  uid: string,
  defaultAgentMmUserId: string,
): Promise<{ token: string } | null> {
  if (!defaultAgentMmUserId) return null;

  await deps.channelHost.revokeTokens(defaultAgentMmUserId, DEFAULT_AGENT_PAT_DESCRIPTION);
  let token: string | null;
  try {
    token = await deps.channelHost.issueToken(defaultAgentMmUserId, DEFAULT_AGENT_PAT_DESCRIPTION);
  } catch {
    return null;
  }
  if (!token) return null;
  await deps.secrets.put(uid, {
    kind: "coach-mattermost",
    secretId: "coachMattermost",
    projectId: null,
    personalToken: token,
    mattermostUserId: defaultAgentMmUserId,
    createdAt: deps.now(),
    rotatedAt: null,
  });
  return { token };
}
