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

// Capture fetch at module-load time so the helper's emulator REST
// calls (collection sweep, Auth user wipe, custom-token exchange) are
// immune to any test that replaces `globalThis.fetch` to assert on
// production-code outbound calls. Without this capture, a test that
// mocks fetch BEFORE awaiting `getIdTokenForUid()` would catch the
// auth-emulator round-trip instead of its intended SUT call — the
// exact failure seen on projects.emulator.spec.ts (mocked fetch
// received the signInWithCustomToken URL).
const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export const TICKETS_COLLECTION = "builderShellTickets";
export const SESSIONS_COLLECTION = "builder_shell_sessions";
export const GATEWAYS_COLLECTION = "glmGateways";

export async function resetEmulator(): Promise<void> {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.GCLOUD_PROJECT;
  if (firestoreHost && project) {
    await originalFetch(
      `http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`,
      { method: "DELETE" },
    ).catch(() => {});
  }
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (authHost && project) {
    await originalFetch(
      `http://${authHost}/emulator/v1/projects/${project}/accounts`,
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
  const res = await originalFetch(
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
