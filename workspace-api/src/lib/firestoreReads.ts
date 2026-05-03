import type { Agent, Channel, Member, Project, Workspace } from "@shared/types";
import { USERNAME_RE } from "@shared/types/identity";
import { db } from "./db";

type DocRef = FirebaseFirestore.DocumentReference;

export async function readProject(ref: DocRef): Promise<Project | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Project) : null;
}

export async function readWorkspace(slug: string): Promise<Workspace | null> {
  if (!USERNAME_RE.test(slug)) return null;
  const snap = await db.doc(`workspaces/${slug}`).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Workspace) : null;
}

export async function readAgent(uid: string): Promise<Agent | null> {
  const snap = await db.doc(`agents/${uid}`).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Agent) : null;
}

export async function readMember(ref: DocRef): Promise<Member | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Member) : null;
}

export async function readChannel(ref: DocRef): Promise<Channel | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Channel) : null;
}
