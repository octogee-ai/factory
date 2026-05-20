// Emulator-backed test helpers for workspace-api Firestore + Firebase
// Auth specs.
//
// Why emulator-backed over mocks: the redeem-path's transaction
// semantics (validate-first / delete-on-success / throw-aborts-batch
// atomicity) plus the requireAuth middleware's verifyIdToken flow are
// exactly what mocks struggle to model. A prior mock test set claimed
// expired tickets were deleted by the redeem transaction — which would
// have been a slow leak in PROD because real Firestore aborts on
// throw. Permanent fix: test against the real thing.
//
// The repo-root firebase.json declares:
//   firestore @ 127.0.0.1:8088
//   auth      @ 127.0.0.1:9099
// Tests run via `firebase emulators:exec`, which sets
// FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST in the child
// process; the firebase-admin SDK auto-routes when those envs are set.

import * as admin from "firebase-admin";
import { db } from "../../lib/db";

export const TICKETS_COLLECTION = "builderShellTickets";
export const SESSIONS_COLLECTION = "builder_shell_sessions";
export const GATEWAYS_COLLECTION = "glmGateways";

async function deleteCollection(name: string): Promise<void> {
  const snap = await db.collection(name).limit(500).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const d of snap.docs) batch.delete(d.ref);
  await batch.commit();
  if (snap.size === 500) await deleteCollection(name);
}

export async function resetEmulator(): Promise<void> {
  await Promise.all([
    deleteCollection(TICKETS_COLLECTION),
    deleteCollection(SESSIONS_COLLECTION),
    deleteCollection(GATEWAYS_COLLECTION),
  ]);
  // Clear all Auth users via the emulator-only deleteUsers REST path.
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const project = process.env.GCLOUD_PROJECT;
  if (host && project) {
    await fetch(
      `http://${host}/emulator/v1/projects/${project}/accounts`,
      { method: "DELETE" },
    ).catch(() => {});
  }
}

export function requireEmulator(): void {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — emulator-backed specs MUST run under `firebase emulators:exec`. Try `npm run test:emulator`.",
    );
  }
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      "FIREBASE_AUTH_EMULATOR_HOST is not set — auth emulator missing. Add `auth` to firebase.json emulators block.",
    );
  }
}

// Mint a real Firebase ID token for `uid` against the Auth emulator.
// admin.createCustomToken → exchanged via the emulator's identitytoolkit
// signInWithCustomToken endpoint → returns an ID token verifyIdToken
// will accept. Same shape as a real client login; exercises the real
// requireAuth middleware end-to-end.
export async function getIdTokenForUid(uid: string): Promise<string> {
  const customToken = await admin.auth().createCustomToken(uid);
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const project = process.env.GCLOUD_PROJECT;
  if (!host || !project) {
    throw new Error("Auth emulator env missing — call requireEmulator() first");
  }
  const res = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  if (!res.ok) {
    throw new Error(`Auth emulator exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { idToken?: string };
  if (!data.idToken) throw new Error("Auth emulator returned no idToken");
  return data.idToken;
}

export async function seedAdmin(uid: string): Promise<void> {
  await db.collection("users").doc(uid).set({
    email: `${uid}@example.com`,
  });
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set({ role: "admin" });
}
