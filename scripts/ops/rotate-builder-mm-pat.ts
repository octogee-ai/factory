import "../lib/octogee-entitlements.js";


import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { type ServerNow } from "@octogee/core/platform-state";
import { deploymentTargetForFirebaseProject } from "@octogee/core/deployment-environment";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import { mmApiCall, revokeAndMintBuilderPat } from "../lib/mattermost.js";
import { pathToFileURL } from "node:url";

const SERVER_NOW: ServerNow = { serverNow: true };

export interface RotateBuilderMmPatArgs {
  project: string;
  target: string;
}

export const ROTATE_BUILDER_MM_PAT_USAGE =
  "Usage: npx tsx scripts/rotate-builder-mm-pat.ts <email-or-uid> --project=<project>";

export function parseRotateBuilderMmPatArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): RotateBuilderMmPatArgs | null {
  const projectArg = argv.find((a) => a.startsWith("--project="));
  const project = projectArg?.split("=")[1] || env.GOOGLE_CLOUD_PROJECT || "octogee-test";
  const target = argv.find((a) => !a.startsWith("--"));
  if (!target) return null;
  return { project, target };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseRotateBuilderMmPatArgs(argv);
  if (!parsed) {
    console.error(ROTATE_BUILDER_MM_PAT_USAGE);
    process.exit(1);
  }
  const { project, target } = parsed;
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: project });
  }
  const auth = getAuth();
  const store = await operatorPlatformStateStore(getFirestore(), deploymentTargetForFirebaseProject(project).targetId);
  let uid: string;
  let email: string;
  if (target.includes("@")) {
    const user = await auth.getUserByEmail(target);
    uid = user.uid;
    email = user.email ?? "(no email)";
  } else {
    const user = await auth.getUser(target);
    uid = user.uid;
    email = user.email ?? "(no email)";
  }

  const builder = await store.builders.records.get(uid);
  if (builder === null) {
    console.error(`❌ No user doc at users/${uid}.`);
    process.exit(1);
  }
  const builderMmUserId = builder.mattermostUserId ?? "";
  if (!builderMmUserId) {
    console.error(`❌ users/${uid} has no mattermost.userId — has this user been provisioned?`);
    process.exit(1);
  }

  const current = await store.secrets.get(uid, "mattermost");
  const createdAt = current?.kind === "builder-mattermost" ? current.createdAt : null;
  const result = await revokeAndMintBuilderPat(
    {
      mmApiCall,
      writeBuilderSecret: async (targetUid, data) => {
        await store.secrets.put(targetUid, {
          kind: "builder-mattermost",
          secretId: "mattermost",
          projectId: null,
          personalToken: data.personalToken,
          mattermostUserId: builderMmUserId,
          createdAt,
          rotatedAt: SERVER_NOW,
        });
      },
      now: () => SERVER_NOW,
      log: (msg) => console.log(msg),
    },
    uid,
    builderMmUserId,
  );

  console.log("");
  console.log(`project: ${project}`);
  console.log(`email:   ${email}`);
  console.log(`uid:     ${uid}`);
  console.log(`outcome: ${result.outcome}`);
  if (result.revokedTokenIds && result.revokedTokenIds.length > 0) {
    console.log(`revoked: ${result.revokedTokenIds.join(", ")}`);
  }
  if (result.outcome === "rotated") {
    console.log(`new token: ...${result.newTokenLastFour}`);
    console.log(`✅ users/${uid}/secrets/mattermost.personalToken updated`);
  } else {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
