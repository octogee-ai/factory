import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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
const runUrl = `${requiredEnv("GITHUB_SERVER_URL")}/${requiredEnv("GITHUB_REPOSITORY")}/actions/runs/${requiredEnv("GITHUB_RUN_ID")}`;

initializeApp({ credential: applicationDefault(), projectId: deploymentEnvironmentSettings(environment).firebaseProjectId });

await runDesktopImagePublication({
  environment,
  sourceSha: requiredEnv("SOURCE_SHA"),
  apply: true,
  actor: `github-actions:${requiredEnv("GITHUB_ACTOR")}`,
  why: `Deploy platform build ${runUrl}`,
  db: getFirestore(),
  auth: new GoogleAuth({ keyFilename: requiredEnv("DESKTOP_IMAGE_COMPUTE_CREDENTIALS"), scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
});
