export const GOOGLE_GRANT_OPERATIONS: Readonly<Record<string, string | null>> =
  {
    "/google/calendar/events": null,
    "/google/calendar/events/create": null,
    "/google/calendar/events/update": "eventId",
    "/google/calendar/events/delete": "eventId",
    "/google/gmail/search": null,
    "/google/gmail/read": "id",
    "/google/gmail/triage": "id",
    "/google/gmail/drafts/create": null,
    "/google/gmail/send": "draftId",
    "/google/contacts/search": null,
    "/google/drive/search": null,
    "/google/drive/read": "fileId",
    "/google/docs/create": null,
    "/google/docs/read": "documentId",
    "/google/docs/append": "documentId",
    "/google/sheets/create": null,
    "/google/sheets/read": "spreadsheetId",
    "/google/sheets/append": "spreadsheetId",
    "/google/tasks/list": "tasklistId",
    "/google/tasks/create": "tasklistId",
    "/google/tasks/update": "taskId",
  };

export interface GoogleGrantPermission {
  operation: string;
  resourceIds: "all" | string[];
  channelIds: string[];
}

export interface GoogleGrantRequest {
  ownerUid: string;
  memberUid: string;
  workspaceId: string;
  connectionEpoch: string;
  membershipEpoch: string;
  operation: string;
  resourceId: string | null;
  channelId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 100 &&
    value.every(
      (id) => typeof id === "string" && /^[a-zA-Z0-9_@.-]{1,256}$/.test(id),
    ) &&
    new Set(value).size === value.length
  );
}

export function parseGoogleGrantPermissions(
  value: unknown,
): GoogleGrantPermission[] | null {
  if (!Array.isArray(value) || value.length > 30) return null;
  const permissions: GoogleGrantPermission[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (
      !item ||
      Object.keys(item).length !== 3 ||
      typeof item.operation !== "string" ||
      !Object.hasOwn(GOOGLE_GRANT_OPERATIONS, item.operation) ||
      (item.resourceIds !== "all" && !ids(item.resourceIds)) ||
      !ids(item.channelIds)
    )
      return null;
    if (
      GOOGLE_GRANT_OPERATIONS[item.operation] === null &&
      item.resourceIds !== "all"
    )
      return null;
    permissions.push({
      operation: item.operation,
      resourceIds: item.resourceIds,
      channelIds: item.channelIds,
    });
  }
  return permissions;
}

export function googleGrantAllows(
  value: unknown,
  request: GoogleGrantRequest,
): boolean {
  const grant = record(value);
  if (!grant || grant.schemaVersion !== 1 || grant.state !== "active")
    return false;
  for (const key of [
    "ownerUid",
    "memberUid",
    "workspaceId",
    "connectionEpoch",
    "membershipEpoch",
  ] as const) {
    if (!request[key] || grant[key] !== request[key]) return false;
  }
  const permissions = parseGoogleGrantPermissions(grant.permissions);
  return (
    permissions !== null &&
    permissions.some(
      (permission) =>
        permission.operation === request.operation &&
        permission.channelIds.includes(request.channelId) &&
        (permission.resourceIds === "all" ||
          (request.resourceId !== null &&
            permission.resourceIds.includes(request.resourceId))),
    )
  );
}

export function googleGrantEpoch(value: unknown): string {
  const stamp = record(value);
  return stamp &&
    Number.isInteger(stamp.seconds) &&
    Number.isInteger(stamp.nanoseconds)
    ? `${stamp.seconds}:${stamp.nanoseconds}`
    : "";
}
