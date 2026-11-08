import type { MattermostTokenSecret, PlatformStateRepositories } from "@octogee/core/platform-state";

export async function readMattermostSecret(
  store: Pick<PlatformStateRepositories, "secrets">,
  uid: string,
  secretId: string,
): Promise<MattermostTokenSecret | null> {
  const secret = await store.secrets.get(uid, secretId);
  return secret === null || secret.kind === "connector" ? null : secret;
}
