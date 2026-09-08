import { createHash } from "node:crypto";
import { FieldValue, type DocumentData, type Firestore, type QuerySnapshot } from "firebase-admin/firestore";
import type { FleetBrokerProjectAgentReadiness } from "@octogee/shared/types/fleet-broker";
import { isValidProjectId } from "@octogee/shared/types/identity";
import { projectAgentEnabled } from "@octogee/shared/types/project";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";

function validChannelIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 128);
}

function parseReadinessReport(value: unknown): FleetBrokerProjectAgentReadiness | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Partial<FleetBrokerProjectAgentReadiness>;
  if (!isValidProjectId(report.projectId) || typeof report.activationId !== "string" ||
    report.activationId.length === 0 || report.activationId.length > 128 ||
    typeof report.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(report.tokenHash) ||
    !validChannelIds(report.channelIds)) return null;
  return { projectId: report.projectId, activationId: report.activationId, tokenHash: report.tokenHash,
    channelIds: [...new Set(report.channelIds)].sort() };
}

export function parseProjectAgentReadinessReports(value: unknown): FleetBrokerProjectAgentReadiness[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const projects: FleetBrokerProjectAgentReadiness[] = [];
  for (const entry of value) {
    const report = parseReadinessReport(entry);
    if (!report) return null;
    projects.push(report);
  }
  return new Set(projects.map((project) => project.projectId)).size === projects.length ? projects : null;
}

function projectChannelIds(channels: QuerySnapshot): string[] {
  return [...new Set(channels.docs.flatMap((channel) => {
    const data = channel.data();
    return data.kind !== "admin" && typeof data.mattermost?.channelId === "string" ? [data.mattermost.channelId as string] : [];
  }))].sort();
}

function activationMatches(input: {
  uid: string;
  report: FleetBrokerProjectAgentReadiness;
  data: DocumentData | undefined;
  secret: DocumentData | undefined;
  channels: QuerySnapshot;
}): boolean {
  const { uid, report, data, secret, channels } = input;
  if (data?.ownerUid !== uid || !projectAgentEnabled(data.agent) ||
    data.commercialLifecycle?.status === "archived" || data.agent.activationId !== report.activationId ||
    !["provisioning", "ready"].includes(data.agent.status)) return false;
  if (typeof secret?.personalToken !== "string") return false;
  return createHash("sha256").update(secret.personalToken).digest("hex") === report.tokenHash &&
    JSON.stringify(projectChannelIds(channels)) === JSON.stringify(report.channelIds);
}

export async function completeProjectAgentActivations(
  db: Firestore,
  input: { uid: string; gatewayId: string; slug: string; projects: FleetBrokerProjectAgentReadiness[] },
): Promise<boolean> {
  return db.runTransaction(async (transaction) => {
    const user = await transaction.get(db.doc(`users/${input.uid}`));
    if (user.data()?.provisioning?.openclaw?.gatewayId !== input.gatewayId) return false;
    const records = await Promise.all(input.projects.map(async (report) => {
      const projectRef = db.doc(`workspaces/${input.slug}/projects/${report.projectId}`);
      const [project, secret, channels] = await Promise.all([
        transaction.get(projectRef),
        transaction.get(db.doc(`users/${input.uid}/secrets/${projectAgentSecretDocId(report.projectId)}`)),
        transaction.get(projectRef.collection("channels")),
      ]);
      return { report, projectRef, data: project.data(), secret: secret.data(), channels };
    }));
    if (!records.every((record) => activationMatches({ uid: input.uid, ...record }))) return false;
    for (const { projectRef, data } of records) {
      if (data?.agent.status === "ready") continue;
      transaction.update(projectRef, {
        "agent.status": "ready", "agent.lastError": null, "agent.updatedAt": FieldValue.serverTimestamp(),
      });
    }
    return true;
  });
}
