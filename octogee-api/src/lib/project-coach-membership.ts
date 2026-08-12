export interface ProjectCoachMembershipInput {
  coachMmUserId: string | null;
  projectChannelIds: readonly string[];
}

type MattermostCall = (method: "DELETE", path: string) => Promise<unknown>;

export async function reconcileCoachProjectMembership(
  input: ProjectCoachMembershipInput,
  call: MattermostCall = mattermostAdminCall,
): Promise<void> {
  if (!input.coachMmUserId) return;
  const channelIds = [...new Set(input.projectChannelIds)].sort();
  for (const channelId of channelIds) {
    try {
      await call("DELETE", `/channels/${channelId}/members/${input.coachMmUserId}`);
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 404) continue;
      throw error;
    }
  }
}

async function mattermostAdminCall(method: "DELETE", path: string): Promise<unknown> {
  const token = process.env.MM_ADMIN_TOKEN;
  if (!token) throw new Error("MM_ADMIN_TOKEN not configured");
  const base =
    process.env.MM_URL
    || process.env.MM_INTERNAL_URL
    || `http://mattermost.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:8065`;
  const response = await fetch(`${base}/api/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    throw Object.assign(new Error(`Mattermost ${method} ${path} returned 404`), { status: 404 });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Mattermost ${method} ${path} failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  return null;
}
