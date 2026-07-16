import {
  extractOpenClawActivationManifest,
  type MigrationActivationManifest,
} from "./migration-activation-manifest.js";
import {
  mattermostAccountSecretRef,
  readMattermostAccountSecret,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";

export async function exportActivationManifestWithSecret(
  configPath: string,
  openclawDir: string,
  slug: string,
): Promise<MigrationActivationManifest> {
  const accountId = `${slug}-coach`;
  const botToken = await readMattermostAccountSecret(openclawDir, accountId);
  if (!botToken) {
    throw new Error(`[migration-activation:${slug}] Mattermost account secret is unavailable`);
  }
  return extractOpenClawActivationManifest(configPath, slug, { botToken });
}

export async function materializeActivationManifestSecret(
  openclawDir: string,
  manifest: MigrationActivationManifest,
): Promise<MigrationActivationManifest> {
  const token = manifest.mattermostAccount.botToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`[migration-activation:${manifest.slug}] transferred Mattermost token is missing`);
  }
  await updateMattermostAccountSecrets(openclawDir, {
    set: { [manifest.accountId]: token },
  });
  return {
    ...manifest,
    mattermostAccount: {
      ...manifest.mattermostAccount,
      botToken: mattermostAccountSecretRef(manifest.accountId),
    },
  };
}
