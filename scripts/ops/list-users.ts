

import { getFirestore } from "firebase-admin/firestore";
import { pathToFileURL } from "node:url";
import { initializeOperatorFirebaseAdmin } from "../lib/operator-firebase-admin.js";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";

function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function formatListUsersLine(id: string, data: Record<string, unknown>): string {
  const complete = data.onboardingComplete ? "✅" : "⏳";
  const tier = stringField(data, "selectedTier", stringField(data, "tier", "?"));
  const provisioning = data.provisioning as { openclaw?: Record<string, unknown>; pendingActivations?: unknown } | undefined;
  const openclaw = provisioning?.openclaw ?? {};
  const prov = stringField(openclaw, "status", "unprov");
  const agents = stringArrayField(openclaw.activatedAgents).join(",") || "none";
  const pending = stringArrayField(provisioning?.pendingActivations).join(",");
  return `${complete} ${stringField(data, "workspaceSlug", "(no-slug)").padEnd(30)} ${stringField(data, "email", "no-email").padEnd(35)} tier=${tier.padEnd(8)} prov=${prov.padEnd(10)} activated=[${agents}]${pending ? " pending=["+pending+"]" : ""}\n   uid=${id}`;
}

async function main() {
  initializeOperatorFirebaseAdmin(deploymentEnvironmentSettings("test").firebaseProjectId);
  const db = getFirestore();
  const snap = await db.collection("users").get();
  console.log(`\n${snap.size} user(s) in Firestore:\n`);
  for (const doc of snap.docs) {
    console.log(formatListUsersLine(doc.id, doc.data()));
  }
  console.log();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}
