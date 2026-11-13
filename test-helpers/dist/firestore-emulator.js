import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth as getFirebaseAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { beforeAll as vitestBeforeAll, beforeEach as vitestBeforeEach, afterAll as vitestAfterAll, } from "vitest";
const originalFetch = globalThis.fetch.bind(globalThis);
function ensureApp() {
    if (getApps().length === 0) {
        initializeApp({
            projectId: process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT ?? "demo-platform",
        });
    }
}
export function getAdminDb() {
    ensureApp();
    return getFirestore();
}
export function getAdminAuth() {
    ensureApp();
    return getFirebaseAuth();
}
const getAuth = getAdminAuth;
export async function resetEmulator() {
    const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
    const project = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT;
    if (firestoreHost && project) {
        await originalFetch(`http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }).catch(() => { });
    }
    const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    if (authHost && project) {
        await originalFetch(`http://${authHost}/emulator/v1/projects/${project}/accounts`, { method: "DELETE" }).catch(() => { });
    }
}
export function requireEmulator() {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
        throw new Error("FIRESTORE_EMULATOR_HOST is not set — emulator-backed specs MUST run under `firebase emulators:exec`. Try `npm run test:emulator`.");
    }
    if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
        throw new Error("FIREBASE_AUTH_EMULATOR_HOST is not set — auth emulator missing. Add `auth` to firebase.json emulators block.");
    }
}
export async function getIdTokenForUid(uid) {
    const customToken = await getAuth().createCustomToken(uid);
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const project = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT;
    if (!host || !project) {
        throw new Error("Auth emulator env missing — call requireEmulator() first");
    }
    const res = await originalFetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    if (!res.ok) {
        throw new Error(`Auth emulator exchange failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json());
    if (!data.idToken)
        throw new Error("Auth emulator returned no idToken");
    return data.idToken;
}
export function setupEmulatorTest(opts = {}) {
    const envSnapshot = {};
    vitestBeforeAll(() => {
        requireEmulator();
        if (opts.env) {
            for (const k of Object.keys(opts.env))
                envSnapshot[k] = process.env[k];
        }
    });
    vitestBeforeEach(async () => {
        await resetEmulator();
        if (opts.env)
            Object.assign(process.env, opts.env);
    });
    vitestAfterAll(async () => {
        await resetEmulator();
        if (opts.env) {
            for (const [k, prior] of Object.entries(envSnapshot)) {
                if (prior === undefined)
                    delete process.env[k];
                else
                    process.env[k] = prior;
            }
        }
    });
}
export function useAuthToken(uid) {
    let token = null;
    vitestBeforeEach(async () => {
        token = await getIdTokenForUid(uid);
    });
    return {
        bearer() {
            if (!token) {
                throw new Error(`useAuthToken("${uid}").bearer() called before beforeEach — call useAuthToken at module scope`);
            }
            return `Bearer ${token}`;
        },
        raw() {
            if (!token) {
                throw new Error(`useAuthToken("${uid}").raw() called before beforeEach`);
            }
            return token;
        },
    };
}
