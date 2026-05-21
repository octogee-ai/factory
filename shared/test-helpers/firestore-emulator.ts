// Cross-package emulator-backed test helpers for Firestore + Firebase
// Auth specs. Used by gateway-edge and chat-proxy; ready for any
// future package that mounts emulator-backed specs.
//
// Why emulator-backed over mocks: real Firestore transaction semantics
// (validate-first / delete-on-success / throw-aborts-batch atomicity)
// plus the requireAuth middleware's verifyIdToken flow are exactly
// what mocks struggle to model. A prior mock test set claimed
// expired tickets were deleted by the redeem transaction — which
// would have been a slow leak in PROD because real Firestore aborts
// on throw. Permanent fix: test against the real thing.
//
// The repo-root firebase.json declares:
//   firestore @ 127.0.0.1:8088
//   auth      @ 127.0.0.1:9099
// Tests run via `firebase emulators:exec`, which sets
// FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST in the child
// process; the firebase-admin SDK auto-routes when those envs are set.
//
// Package-agnostic: this helper does NOT import a specific package's
// `lib/db`. Each package's lib/db (which initializes firebase-admin)
// races with this helper's lazy `ensureApp()` — whoever runs first
// wins, the other is a no-op. Both end up sharing the same
// `admin.apps[0]` because admin.apps is a process-global registry.

import * as admin from "firebase-admin";
import {
  beforeAll as vitestBeforeAll,
  beforeEach as vitestBeforeEach,
  afterAll as vitestAfterAll,
} from "vitest";

// Capture fetch at module-load time so the helper's emulator REST
// calls (collection sweep, Auth user wipe, custom-token exchange) are
// immune to any test that replaces `globalThis.fetch` to assert on
// production-code outbound calls. Without this capture, a test that
// mocks fetch BEFORE awaiting `getIdTokenForUid()` would catch the
// auth-emulator round-trip instead of its intended SUT call.
const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function ensureApp(): void {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      projectId: process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT ?? "octogee-test",
    });
  }
}

// Lazy-init admin handles for specs that need direct Firestore / Auth
// access (seeding, readback, custom queries). Each call ensures the
// admin app is initialized — safe to call multiple times.
export function getAdminDb(): admin.firestore.Firestore {
  ensureApp();
  return admin.firestore();
}

export function getAdminAuth(): admin.auth.Auth {
  ensureApp();
  return admin.auth();
}

// Internal aliases kept for the helper's own use (one indirection only).
const getDb = getAdminDb;
const getAuth = getAdminAuth;

// NOTE: collection-name constants intentionally NOT exported here.
// They are package-domain (gateway-edge: builderShellTickets,
// builder_shell_sessions, glmGateways; chat-proxy: ocTickets, etc.)
// Each package's specs define what they need.

export async function resetEmulator(): Promise<void> {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT;
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
// will accept. Same shape as a real client login.
export async function getIdTokenForUid(uid: string): Promise<string> {
  const customToken = await getAuth().createCustomToken(uid);
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const project = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT;
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

// Registers the standard emulator-test lifecycle. Module-scope hooks
// fire in registration order, so calling this BEFORE `useAuthToken(uid)`
// guarantees the token mint runs against a clean Auth emulator.
// Optional `env` snapshot: process.env keys are written before each
// test and restored to their pre-suite values at afterAll — avoids
// env-leak between specs in the same process.
export function setupEmulatorTest(opts: { env?: Record<string, string> } = {}): void {
  const envSnapshot: Record<string, string | undefined> = {};
  vitestBeforeAll(() => {
    requireEmulator();
    if (opts.env) {
      for (const k of Object.keys(opts.env)) envSnapshot[k] = process.env[k];
    }
  });
  vitestBeforeEach(async () => {
    await resetEmulator();
    if (opts.env) Object.assign(process.env, opts.env);
  });
  vitestAfterAll(async () => {
    await resetEmulator();
    if (opts.env) {
      for (const [k, prior] of Object.entries(envSnapshot)) {
        if (prior === undefined) delete process.env[k];
        else process.env[k] = prior;
      }
    }
  });
}

// Pre-minted ID token, refreshed in beforeEach. Sync `.bearer()` lets
// per-route supertest helpers stay chainable. The Promise<Test> trap
// from `async function connect() { return request().post().set(await
// getIdTokenForUid(...)) }` is what this avoids: awaiting the returned
// Promise auto-sends the supertest Test, so any `.send()` chained
// after fails on the Response.
export interface AuthTokenHandle {
  bearer: () => string;
  raw: () => string;
}

export function useAuthToken(uid: string): AuthTokenHandle {
  let token: string | null = null;
  vitestBeforeEach(async () => {
    token = await getIdTokenForUid(uid);
  });
  return {
    bearer(): string {
      if (!token) {
        throw new Error(
          `useAuthToken("${uid}").bearer() called before beforeEach — call useAuthToken at module scope`,
        );
      }
      return `Bearer ${token}`;
    },
    raw(): string {
      if (!token) {
        throw new Error(`useAuthToken("${uid}").raw() called before beforeEach`);
      }
      return token;
    },
  };
}
