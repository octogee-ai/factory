import { FieldValue } from "firebase-admin/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { log } from "../config.js";
import { db } from "../firebase.js";
import { mmApiCall, getMmAdminToken } from "./client.js";
import { SINGLE_REGION_REPLICATION } from "../secret-manager.js";

const secretClient = new SecretManagerServiceClient();

export async function ensureAdminCredentials(): Promise<void> {
  const MM_URL = process.env.MM_URL;
  if (!MM_URL) {
    log("[admin-creds] skipping — MM_URL not set");
    return;
  }

  const token = await getMmAdminToken();
  if (!token) {
    log("[admin-creds] skipping — no admin token");
    return;
  }

let adminUserId = process.env.MM_ADMIN_USER_ID;
  if (!adminUserId) {
    const adminUser = process.env.MM_ADMIN_USER;
    if (adminUser) {
      const user = await mmApiCall("GET", `/users/username/${adminUser}`);
      if (user?.id) {
        adminUserId = user.id;
        log(`[admin-creds] looked up admin user ID: ${adminUserId}`);
      }
    }
  }

  if (!adminUserId) {
    log("[admin-creds] skipping — could not determine admin user ID (set MM_ADMIN_USER_ID or MM_ADMIN_USER)");
    return;
  }

  const proxyUrl = process.env.API_PUBLIC_URL || "";

const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "octogee";
  const secretName = `projects/${project}/secrets/MM_ADMIN_TOKEN`;
  try {
    await secretClient.addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(token) },
    });
    log(`[admin-creds] MM_ADMIN_TOKEN written to Secret Manager`);
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 5) {
      
      await secretClient.createSecret({
        parent: `projects/${project}`,
        secretId: "MM_ADMIN_TOKEN",
        secret: { replication: SINGLE_REGION_REPLICATION },
      });
      await secretClient.addSecretVersion({
        parent: secretName,
        payload: { data: Buffer.from(token) },
      });
      log(`[admin-creds] MM_ADMIN_TOKEN created in Secret Manager`);
    } else {
      log(`[admin-creds] ⚠ failed to write MM_ADMIN_TOKEN to Secret Manager: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

await db.doc("system/mattermostAdmin").set({
    userId: adminUserId,
    proxyUrl,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  log(`[admin-creds] stored admin credentials for user ${adminUserId}`);
}
