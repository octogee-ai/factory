

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const projectArg = args.find(a => a.startsWith("--project="));
const project = projectArg?.split("=")[1] || process.env.GOOGLE_CLOUD_PROJECT || "octogee-test";
const target = args.find(a => !a.startsWith("--"));

if (!target) {
  console.error("Usage: npx tsx scripts/set-admin-role.ts <email-or-uid> --project=<project> [--revoke]");
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({ credential: applicationDefault(), projectId: project });
}

const auth = getAuth();
const db = getFirestore();

async function main() {
  let uid: string;
  let email: string;

  if (target!.includes("@")) {
    const user = await auth.getUserByEmail(target!);
    uid = user.uid;
    email = user.email!;
  } else {
    const user = await auth.getUser(target!);
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

main().catch((e) => { console.error(e.message || e); process.exit(1); });
