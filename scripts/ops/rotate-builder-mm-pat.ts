

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { mmApiCall, revokeAndMintBuilderPat } from "../lib/mattermost.js";

const args = process.argv.slice(2);
const projectArg = args.find((a) => a.startsWith("--project="));
const project = projectArg?.split("=")[1] || process.env.GOOGLE_CLOUD_PROJECT || "octogee-test";
const target = args.find((a) => !a.startsWith("--"));

if (!target) {
  console.error(
    "Usage: npx tsx scripts/rotate-builder-mm-pat.ts <email-or-uid> --project=<project>",
  );
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({ credential: applicationDefault(), projectId: project });
}

const auth = getAuth();
const db = getFirestore();

async function main(): Promise<void> {
  let uid: string;
  let email: string;
  if (target!.includes("@")) {
    const user = await auth.getUserByEmail(target!);
    uid = user.uid;
    email = user.email ?? "(no email)";
  } else {
    const user = await auth.getUser(target!);
    uid = user.uid;
    email = user.email ?? "(no email)";
  }

  const userDoc = await db.doc(`users/${uid}`).get();
  if (!userDoc.exists) {
    console.error(`❌ No user doc at users/${uid}.`);
    process.exit(1);
  }
  const userData = userDoc.data() ?? {};
  const builderMmUserId =
    typeof userData.mattermost === "object" && userData.mattermost !== null
      ? String((userData.mattermost as { userId?: unknown }).userId ?? "")
      : "";
  if (!builderMmUserId) {
    console.error(`❌ users/${uid} has no mattermost.userId — has this user been provisioned?`);
    process.exit(1);
  }

  const result = await revokeAndMintBuilderPat(
    {
      mmApiCall,
      writeBuilderSecret: async (targetUid, data) => {
        await db
          .collection("users")
          .doc(targetUid)
          .collection("secrets")
          .doc("mattermost")
          .set(data);
      },
      now: () => FieldValue.serverTimestamp(),
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
