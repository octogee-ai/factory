#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  parseSilentPostProbeArgs,
  runMattermostSilentPostProbe,
} from "../lib/mattermost/verify-silent-post.js";

export async function runVerifySilentPost(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const config = parseSilentPostProbeArgs(argv, env);
  if (!config) {
    console.error(
      "Usage: verify-silent-post --base-url=<url> --channel-id=<id> --observer-user-id=<id> --observer-username=<name>; MM_BOT_TOKEN, MM_HUMAN_TOKEN, and MM_OBSERVER_TOKEN are required",
    );
    return 2;
  }
  const report = await runMattermostSilentPostProbe(config);
  const failed = Object.entries(report).filter(([, passed]) => !passed).map(([name]) => name);
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    console.error(`Mattermost silent-post capability failed: ${failed.join(", ")}`);
    return 1;
  }
  console.log("Mattermost silent-post capability passed");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVerifySilentPost().then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
