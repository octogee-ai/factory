

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { pathToFileURL } from "node:url";

export interface SetAdminRoleArgs {
  project: string;
  revoke: boolean;
  target: string;
}

export const SET_ADMIN_ROLE_USAGE =
  "Usage: npx tsx scripts/set-admin-role.ts <email-or-uid> --project=<project> [--revoke]";

export function parseSetAdminRoleArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): SetAdminRoleArgs | null {
  const revoke = argv.includes("--revoke");
  const projectArg = argv.find((a) => a.startsWith("--project="));
  const project = projectArg?.split("=")[1] || env.GOOGLE_CLOUD_PROJECT || "octogee-test";
  const target = argv.find((a) => !a.startsWith("--"));
  if (!target) return null;
  return { project, revoke, target };
}

async function main(argv: string[] = process.argv.slice(2)) {
  const parsed = parseSetAdminRoleArgs(argv);
  if (!parsed) {
    console.error(SET_ADMIN_ROLE_USAGE);
    process.exit(1);
  }
  const { project, revoke, target } = parsed;
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: project });
  }
  const auth = getAuth();
  const db = getFirestore();
  let uid: string;
  let email: string;

  if (target.includes("@")) {
    const user = await auth.getUserByEmail(target);
    uid = user.uid;
    email = user.email!;
  } else {
    const user = await auth.getUser(target);
    uid = user.uid;
    email = user.email ?? "(no email)";
  }

const userDoc = await db.doc(`users/${uid}`).get();
  if (!userDoc.exists) {
    console.error(`❌ No user doc found at users/${uid}. Has this user signed up?`);
    process.exit(1);
  }

const configRef = db.doc(`users/${uid}/system/config`);

  if (revoke) {
    await configRef.set({ role: FieldValue.delete() }, { merge: true });
  } else {
    await configRef.set({ role: "admin" }, { merge: true });
  }

const userData = userDoc.data();
  if (userData?.role) {
    await db.doc(`users/${uid}`).update({ role: FieldValue.delete() });
    console.log(`   ⚠ Removed legacy top-level role field`);
  }

  console.log(`\n✅ ${revoke ? "Revoked" : "Granted"} admin role`);
  console.log(`   project: ${project}`);
  console.log(`   email:   ${email}`);
  console.log(`   uid:     ${uid}`);
  console.log(`   users/${uid}/system/config.role = ${revoke ? "(deleted)" : '"admin"'}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
