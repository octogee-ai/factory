import { pathToFileURL } from "node:url";
import { builderClaimSlug } from "@octogee/shared/server/builder-claim";
import { prepareBuilderProjectStorage } from "../lib/builder-project-storage.js";

const OPENCLAW_DIR = "/home/node/.openclaw";

export function projectStorageSlug(env: NodeJS.ProcessEnv): string {
  const slug = builderClaimSlug(env);
  if (!slug) {
    throw new Error("project storage preparation requires the Builder claim the VM agent writes before init");
  }
  return slug;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareBuilderProjectStorage({
    home: "/home/node",
    projects: "/work/materialized",
    slug: projectStorageSlug({ OPENCLAW_DIR, GATEWAY_ID: process.env.GATEWAY_ID }),
  });
}
