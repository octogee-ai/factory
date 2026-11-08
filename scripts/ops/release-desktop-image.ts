import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import { GoogleAuth } from "google-auth-library";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { runDesktopImagePublication } from "../lib/desktop-image-publication.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`release-desktop-image requires ${name}`);
  return value;
}

const environment = requiredEnv("RELEASE_ENVIRONMENT");
if (environment !== "test" && environment !== "prod") throw new Error(`release-desktop-image: unknown environment ${environment}`);

initializeApp({ credential: applicationDefault(), projectId: deploymentEnvironmentSettings(environment).firebaseProjectId });

await runDesktopImagePublication({
  environment,
  sourceSha: requiredEnv("SOURCE_SHA"),
  apply: true,
  skipMissing: true,
  actor: requiredEnv("RELEASE_ACTOR"),
  why: requiredEnv("RELEASE_REASON"),
  store: await operatorPlatformStateStore(getFirestore(), deploymentEnvironmentSettings(environment).targetId),
  auth: new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
});
