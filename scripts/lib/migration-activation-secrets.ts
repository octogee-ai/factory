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
  return extractOpenClawActivationManifest(configPath, slug, {
    resolveBotToken: async (accountId) =>
      (await readMattermostAccountSecret(openclawDir, accountId)) ?? undefined,
  });
}

export async function materializeActivationManifestSecret(
  openclawDir: string,
  manifest: MigrationActivationManifest,
): Promise<MigrationActivationManifest> {
  const projectAgents = manifest.projectAgents ?? [];
  const accounts = [
    {
      accountId: manifest.accountId,
      mattermostAccount: manifest.mattermostAccount,
    },
    ...projectAgents,
  ];
  const tokens: Record<string, string> = {};
  for (const account of accounts) {
    const token = account.mattermostAccount.botToken;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `[migration-activation:${manifest.slug}] transferred Mattermost token is missing for ${account.accountId}`,
      );
    }
    tokens[account.accountId] = token;
  }
  await updateMattermostAccountSecrets(openclawDir, {
    set: tokens,
    removePrefixes: [`${manifest.slug}-proj-`],
  });
  return {
    ...manifest,
    mattermostAccount: {
      ...manifest.mattermostAccount,
      botToken: mattermostAccountSecretRef(manifest.accountId),
    },
    projectAgents: projectAgents.map((project) => ({
      ...project,
      mattermostAccount: {
        ...project.mattermostAccount,
        botToken: mattermostAccountSecretRef(project.accountId),
      },
    })),
  };
}
