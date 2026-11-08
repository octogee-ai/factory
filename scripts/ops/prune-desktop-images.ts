#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { operatorPlatformStateStore } from "../lib/platform-state-store.js";
import { GoogleAuth } from "google-auth-library";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { DESKTOP_ARCHIVE_KEEP_DEFAULT, runDesktopArchivePrune } from "../lib/desktop-image-publication.js";

const { values } = parseArgs({ options: {
  env: { type: "string" }, keep: { type: "string" }, apply: { type: "boolean", default: false }, actor: { type: "string" }, why: { type: "string" },
} });
const environment = values.env;
if (environment !== "test" && environment !== "prod") {
  throw new Error("Usage: prune-desktop-images.ts --env=test|prod [--keep=N] [--apply --actor=<who> --why=<reason>]");
}
if (values.apply && (!values.actor || !values.why)) throw new Error("--apply requires --actor and --why for the operations journal");
initializeApp({ credential: applicationDefault(), projectId: deploymentEnvironmentSettings(environment).firebaseProjectId });
const result = await runDesktopArchivePrune({
  environment,
  keep: values.keep === undefined ? DESKTOP_ARCHIVE_KEEP_DEFAULT : Number(values.keep),
  apply: values.apply,
  actor: values.actor ?? "operator",
  why: values.why ?? "dry run",
  store: await operatorPlatformStateStore(getFirestore(), deploymentEnvironmentSettings(environment).targetId),
  auth: new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
});
if (!values.apply && result.remove.length > 0) console.log(`Dry run: rerun with --apply --actor=<who> --why=<reason> to remove ${result.remove.length} archived image(s).`);
