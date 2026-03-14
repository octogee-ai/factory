/**
 * set-admin-role.ts — grant or revoke admin role on a Octogee user document
 *
 * The admin dashboard Cloud Function checks `role: 'admin'` on the calling
 * user's Firestore document (users/{uid}). This script sets or clears it.
 *
 * Usage:
 *   npx tsx scripts/set-admin-role.ts <email-or-uid>          # grant admin
 *   npx tsx scripts/set-admin-role.ts <email-or-uid> --revoke # revoke admin
 */
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SA_KEY_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ??
  path.join(os.homedir(), ".openclaw/secrets/octogee-test-sa-key.json");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf-8"))) });
}

const auth = getAuth();
const db = getFirestore();

const [target, flag] = process.argv.slice(2);
const revoke = flag === "--revoke";

if (!target) {
  console.error("Usage: npx tsx scripts/set-admin-role.ts <email-or-uid> [--revoke]");
  process.exit(1);
}

async function main() {
  // Accept either email or UID directly
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

  await db.doc(`users/${uid}`).set(
    { role: revoke ? null : "admin" },
    { merge: true }
  );

  console.log(`\n✅ ${revoke ? "Revoked" : "Granted"} admin role`);
  console.log(`   email: ${email}`);
  console.log(`   uid:   ${uid}`);
  console.log(`   users/${uid}.role = ${revoke ? "null" : '"admin"'}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
