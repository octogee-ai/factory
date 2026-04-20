/**
 * Typed Firestore read wrappers — `.get().data()` with the right type at
 * the call site.
 *
 * Problem: every route did `const data = snap.data()!` and then accessed
 * fields on a `DocumentData` (which is effectively `any`). TypeScript
 * couldn't catch typos, CodeQL couldn't trace data flow, and reading an
 * unfamiliar doc meant grepping the codebase to find out what fields
 * actually live on it.
 *
 * Solution: one reader per top-level doc shape. Each wrapper:
 *   1. Fetches the doc.
 *   2. Returns `null` if the doc doesn't exist — callers get a clean
 *      "not found" signal instead of an `undefined` field fallthrough.
 *   3. Casts the data to the canonical interface from `@shared/types/*`.
 *
 * We deliberately skip per-field runtime validation. The value of the
 * wrapper is TypeScript catching field-name typos at every call site and
 * CodeQL seeing a real type through the data plane. Runtime shape
 * validation would break sparse test fixtures for zero real-world payoff
 * — prod docs are written atomically with all required fields, and legacy
 * partial reads (e.g. a doc existing but missing a nullable field) are
 * common in non-test code paths.
 *
 * Scope: Project, Workspace, Agent, Member, Channel. These five have
 * canonical interfaces in `@shared/types/` and together cover the bulk
 * of `.data()` calls in the routes. Reads of user docs + internal config
 * subdocs (users/{uid}/system/config, etc.) stay untyped for now — they
 * have no canonical schema.
 */
import type { Agent, Channel, Member, Project, Workspace } from "@shared/types";
import { USERNAME_RE } from "@shared/types/identity";
import { db } from "./db";

type DocRef = FirebaseFirestore.DocumentReference;

/**
 * Fetch `workspaces/{wid}/projects/{pid}`. Caller supplies the ref
 * (every project-route already has it to hand and typically updates
 * it after read, so returning `Project` alone would force a second
 * Firestore call to write).
 */
export async function readProject(ref: DocRef): Promise<Project | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Project) : null;
}

/**
 * Fetch `workspaces/{slug}` by its slug (= the owner's username). Returns
 * null for unknown slugs or when the slug fails the username-regex gate
 * — malformed input can't steer Firestore path construction.
 */
export async function readWorkspace(slug: string): Promise<Workspace | null> {
  if (!USERNAME_RE.test(slug)) return null;
  const snap = await db.doc(`workspaces/${slug}`).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Workspace) : null;
}

/**
 * Fetch `agents/{uid}`. Returns null when the Agent hasn't been
 * provisioned yet (happens briefly between user creation and the
 * scripts/provisionSteps.ts sweep).
 */
export async function readAgent(uid: string): Promise<Agent | null> {
  const snap = await db.doc(`agents/${uid}`).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Agent) : null;
}

/**
 * Fetch a membership doc from either `workspaces/{wid}/members/{uid}`
 * or `workspaces/{wid}/projects/{pid}/members/{uid}`. Caller supplies
 * the ref — the path is mechanical but the choice of which subtree to
 * read is semantic (workspace-vs-project membership) and better left
 * explicit at the call site.
 */
export async function readMember(ref: DocRef): Promise<Member | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Member) : null;
}

/**
 * Fetch a channel pointer doc — `workspaces/{wid}/channels/{cid}` or
 * `workspaces/{wid}/projects/{pid}/channels/{cid}`. Ref-based for the
 * same reason as readMember.
 */
export async function readChannel(ref: DocRef): Promise<Channel | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Channel) : null;
}
