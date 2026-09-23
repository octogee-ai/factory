import {
  FieldValue,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
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

export async function applyGoogleGrantApproval(
  db: Firestore,
  tx: Transaction,
  ownerUid: string,
  value: unknown,
): Promise<boolean> {
  const request = parseGoogleGrantApproval(value);
  const grantRef = db.doc(
    `users/${ownerUid}/googleGrants/${request.memberUid}`,
  );
  const [member, connection, workspace, grant] = await Promise.all([
    tx.get(
      db.doc(`workspaces/${request.workspaceId}/members/${request.memberUid}`),
    ),
    tx.get(db.doc(`users/${ownerUid}/integrations/google`)),
    tx.get(db.doc(`workspaces/${request.workspaceId}`)),
    tx.get(grantRef),
  ]);
  if (
    workspace.data()?.ownerUid !== ownerUid ||
    workspace.data()?.ownerActive !== true ||
    !isCanonicalWorkspaceMembership(member.data()) ||
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
    approvedBy: ownerUid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return true;
}
