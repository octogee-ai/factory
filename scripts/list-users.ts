

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SA_KEY_PATH = path.join(os.homedir(), ".openclaw/secrets/octogee-test-sa-key.json");
if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf-8"))) });
}
const db = getFirestore();

async function main() {
  const snap = await db.collection("users").get();
  console.log(`\n${snap.size} user(s) in Firestore:\n`);
  for (const doc of snap.docs) {
    const d = doc.data();
    const complete = d.onboardingComplete ? "✅" : "⏳";
    const tier = d.selectedTier || d.tier || "?";
    const prov = d.provisioning?.openclaw?.status || "unprov";
    const agents = (d.provisioning?.openclaw?.activatedAgents || []).join(",") || "none";
    const pending = (d.provisioning?.pendingActivations || []).join(",");
    console.log(
      `${complete} ${(d.workspaceSlug || "(no-slug)").padEnd(30)} ${(d.email || "no-email").padEnd(35)} tier=${tier.padEnd(8)} prov=${prov.padEnd(10)} activated=[${agents}]${pending ? " pending=["+pending+"]" : ""}`
    );
    console.log(`   uid=${doc.id}`);
  }
  console.log();
}
main().catch(console.error);
