import { FieldValue } from "firebase-admin/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { log } from "../config.js";
import { db } from "../firebase.js";
import { mmApiCall, getMmAdminToken } from "./client.js";

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

  // Get admin user ID from env or look up by username
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

  const proxyUrl = process.env.CHAT_PROXY_URL || "";

  // Write token to Secret Manager (not Firestore — it's a credential)
  const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "octogee";
  const secretName = `projects/${project}/secrets/MM_ADMIN_TOKEN`;
  try {
    await secretClient.addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(token) },
    });
    log(`[admin-creds] MM_ADMIN_TOKEN written to Secret Manager`);
  } catch (err: any) {
    if (err?.code === 5) {
      // Secret doesn't exist yet — create it
      await secretClient.createSecret({
        parent: `projects/${project}`,
        secretId: "MM_ADMIN_TOKEN",
        secret: { replication: { automatic: {} } },
      });
      await secretClient.addSecretVersion({
        parent: secretName,
        payload: { data: Buffer.from(token) },
      });
      log(`[admin-creds] MM_ADMIN_TOKEN created in Secret Manager`);
    } else {
      log(`[admin-creds] ⚠ failed to write MM_ADMIN_TOKEN to Secret Manager: ${err?.message}`);
    }
  }

  // Write non-sensitive metadata to Firestore (userId, proxyUrl — no token)
  await db.doc("system/mattermostAdmin").set({
    userId: adminUserId,
    proxyUrl,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  log(`[admin-creds] stored admin credentials for user ${adminUserId}`);
}
