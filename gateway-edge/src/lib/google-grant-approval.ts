import {
  FieldValue,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import {
  googleGrantEpoch,
  parseGoogleGrantPermissions,
} from "./google-collaborator-grants.js";

export interface GoogleGrantApproval {
  memberUid: string;
  memberName: string;
  workspaceId: string;
  accountLabel: string;
  operationLabel: string;
  channelName: string;
  connectionEpoch: string;
  membershipEpoch: string;
  grantEpoch: string;
  permissions: NonNullable<ReturnType<typeof parseGoogleGrantPermissions>>;
}

export function parseGoogleGrantApproval(value: unknown): GoogleGrantApproval {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Google grant approval");
  const input = value as Record<string, unknown>;
  const permissions = parseGoogleGrantPermissions(input.permissions);
  const fields = [
    "memberUid",
    "memberName",
    "workspaceId",
    "accountLabel",
    "operationLabel",
    "channelName",
    "connectionEpoch",
    "membershipEpoch",
    "grantEpoch",
  ];
  if (
    !permissions ||
    permissions.length !== 1 ||
    fields.some(
      (key) =>
        typeof input[key] !== "string" ||
        (key !== "grantEpoch" && !input[key]) ||
        (input[key] as string).length > 512,
    ) ||
    !/^[a-zA-Z0-9_-]+$/.test(input.memberUid as string) ||
    !/^[a-z0-9-]+$/.test(input.workspaceId as string)
  )
    throw new Error("Invalid Google grant approval");
  return {
    ...Object.fromEntries(fields.map((key) => [key, input[key]])),
    permissions,
  } as unknown as GoogleGrantApproval;
}

function existingPermissions(stored: Record<string, unknown> | undefined, request: GoogleGrantApproval) {
  const current =
    stored?.state === "active" &&
    stored?.connectionEpoch === request.connectionEpoch &&
    stored?.membershipEpoch === request.membershipEpoch
      ? parseGoogleGrantPermissions(stored.permissions)
      : [];
  if (!current) throw new Error("Invalid stored Google grant");
  return current;
}

// eslint-disable-next-line max-params -- Firestore handle, platform store, and transaction are separate authorities beside the request identity
export async function applyGoogleGrantApproval(
  db: Firestore,
  store: Pick<PlatformStateStore, "workspaces">,
  tx: Transaction,
  ownerUid: string,
  value: unknown,
  approvalId: string,
): Promise<boolean> {
  const request = parseGoogleGrantApproval(value);
  const grantRef = db.doc(
    `users/${ownerUid}/googleGrants/${request.memberUid}`,
  );
  const [storedMember, workspace, member, connection, grant] = await Promise.all([
    store.workspaces.members.get(request.workspaceId, request.memberUid),
    store.workspaces.records.get(request.workspaceId),
    tx.get(
      db.doc(`workspaces/${request.workspaceId}/members/${request.memberUid}`),
    ),
    tx.get(db.doc(`users/${ownerUid}/integrations/google`)),
    tx.get(grantRef),
  ]);
  if (
    workspace?.ownerUid !== ownerUid ||
    workspace.ownerActive !== true ||
    !isCanonicalWorkspaceMembership(storedMember) ||
    connection.data()?.status !== "connected" ||
    googleGrantEpoch(member.createTime) !== request.membershipEpoch ||
    googleGrantEpoch(connection.data()?.connectedAt) !==
      request.connectionEpoch ||
    googleGrantEpoch(grant.updateTime) !== request.grantEpoch
  )
    return false;
  const stored = grant.data();
  const current = existingPermissions(stored, request);
  const permissions = [...current, ...request.permissions].filter(
    (item, index, all) =>
      all.findIndex(
        (other) => JSON.stringify(other) === JSON.stringify(item),
      ) === index,
  );
  if (!parseGoogleGrantPermissions(permissions)) return false;
  tx.set(grantRef, {
    schemaVersion: 1,
    ownerUid,
    memberUid: request.memberUid,
    workspaceId: request.workspaceId,
    state: "active",
    connectionEpoch: request.connectionEpoch,
    membershipEpoch: request.membershipEpoch,
    permissions,
    approvalId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return true;
}
