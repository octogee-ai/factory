import { pathToFileURL } from "node:url";
import { hydrateGithubCliAuth } from "../lib/github-cli-auth-hydrate.js";

async function main(): Promise<void> {
  await hydrateGithubCliAuth();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[github-cli-auth] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
