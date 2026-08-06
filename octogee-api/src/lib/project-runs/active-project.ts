const ACTIVE_PROJECT_STATUSES = new Set(["idea", "building", "launched", "paused"]);

function nestedStatus(data: Record<string, unknown>, field: string): unknown {
  const value = data[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).status
    : undefined;
}

function absentOrActive(data: Record<string, unknown>, field: string): boolean {
  return data[field] === undefined || nestedStatus(data, field) === "active";
}

export function isRunnableProject(data: Record<string, unknown>, ownerUid?: string): boolean {
  return (ownerUid === undefined || data.ownerUid === ownerUid)
    && data.ownerActive === true
    && typeof data.status === "string"
    && ACTIVE_PROJECT_STATUSES.has(data.status)
    && data.provisioningState === "active"
    && absentOrActive(data, "commercialLifecycle")
    && absentOrActive(data, "retention");
}
