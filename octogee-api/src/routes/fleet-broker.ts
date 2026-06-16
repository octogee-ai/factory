import { Router, type Request, type Response } from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { isValidUsername } from "../../../shared/types/identity.js";
import type {
  FleetBrokerChannelBinding,
  FleetBrokerGreetingResult,
  FleetBrokerMattermostUpdate,
  FleetBrokerProjectRestore,
  FleetBrokerProvisioningStatus,
  FleetBrokerUserSnapshot,
} from "../../../shared/types/fleet-broker.js";
import {
  mapProjectChannelDoc,
  mapWorkspaceChannelDoc,
} from "../../../scripts/lib/customer-snapshot-mapping.js";
import { slugFromAssignedUser } from "../../../scripts/lib/assigned-roster.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;

interface FleetBrokerRouteDeps {
  provisionMattermost?: (input: {
    uid: string;
    userData: Record<string, unknown>;
  }) => Promise<FleetBrokerMattermostUpdate>;
  markProvisioningComplete?: (input: {
    uid: string;
    userData: Record<string, unknown>;
    mmUpdate: FleetBrokerMattermostUpdate;
  }) => Promise<void>;
  notifyOpsOfSignup?: (input: {
    uid: string;
    userData: Record<string, unknown>;
  }) => Promise<void>;
}

async function defaultProvisionMattermost(input: {
  uid: string;
  userData: Record<string, unknown>;
}): Promise<FleetBrokerMattermostUpdate> {
  const { buildProvisioningContext, provisionMattermost } = await import(
    "../../../scripts/lib/provisionSteps.js"
  );
  return provisionMattermost(buildProvisioningContext(input.uid, input.userData));
}

async function defaultMarkProvisioningComplete(input: {
  uid: string;
  userData: Record<string, unknown>;
  mmUpdate: FleetBrokerMattermostUpdate;
}): Promise<void> {
  const { buildProvisioningContext, markProvisioningComplete } = await import(
    "../../../scripts/lib/provisionSteps.js"
  );
  const ctx = buildProvisioningContext(input.uid, input.userData);
  await markProvisioningComplete(ctx, input.mmUpdate, [`octogee-${ctx.slug}-coach`]);
}

async function defaultNotifyOpsOfSignup(input: {
  uid: string;
  userData: Record<string, unknown>;
}): Promise<void> {
  const { buildProvisioningContext, notifyOpsOfSignup } = await import(
    "../../../scripts/lib/provisionSteps.js"
  );
  await notifyOpsOfSignup(buildProvisioningContext(input.uid, input.userData));
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = typeof req.body?.gatewayId === "string" ? req.body.gatewayId : "";
  if (claimed && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function readPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringAt(obj: Record<string, unknown> | undefined, dotted: string): string {
  const value = readPath(obj, dotted);
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function objectBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

function recordBodyValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isProvisioningStatus(value: unknown): value is Exclude<FleetBrokerProvisioningStatus, ""> {
  return value === "provisioning" || value === "complete";
}

function isGreetingResult(value: unknown): value is FleetBrokerGreetingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.ok === true) return typeof v.jobId === "string" && v.jobId.length > 0;
  if (v.ok === false) return typeof v.error === "string" && v.error.length > 0;
  return false;
}

function validAgentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length === value.length ? ids : null;
}

async function requireAssignedUser(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; uid: string; data: Record<string, unknown> } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
  if (!uid) {
    res.status(400).json({ error: "uid_required" });
    return null;
  }
  const data = await isAssignedToGateway(db, bound.gatewayId, uid);
  if (!data) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid, data };
}

async function requireAssignedSlug(
  db: Firestore,
  req: Request,
  res: Response,
): Promise<{ bound: GatewayBinding; uid: string; slug: string } | null> {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  if (!isValidUsername(slug)) {
    res.status(400).json({ error: "invalid_slug" });
    return null;
  }
  const uid = await findAssignedUidBySlug(db, bound.gatewayId, slug);
  if (!uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid, slug };
}

async function runBrokered(
  res: Response,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function collectChannelBindings(
  db: Firestore,
  slug: string,
): Promise<FleetBrokerChannelBinding[]> {
  const workspaceRef = db.collection("workspaces").doc(slug);
  const [wsChannels, projects] = await Promise.all([
    workspaceRef.collection("channels").get(),
    workspaceRef.collection("projects").get(),
  ]);

  const bindings: FleetBrokerChannelBinding[] = [];
  for (const ch of wsChannels.docs) {
    const b = mapWorkspaceChannelDoc(ch.data());
    if (b) bindings.push(b);
  }
  for (const p of projects.docs) {
    const projChannels = await p.ref.collection("channels").get();
    for (const ch of projChannels.docs) {
      const b = mapProjectChannelDoc(p.id, ch.data());
      if (b) bindings.push(b);
    }
  }
  return bindings;
}

async function collectProjects(
  db: Firestore,
  slug: string,
): Promise<FleetBrokerProjectRestore[]> {
  const snap = await db.collection("workspaces").doc(slug).collection("projects").get();
  return snap.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    const out: FleetBrokerProjectRestore = {
      projectSlug: doc.id,
      giteaRepoName: typeof data.giteaRepoName === "string" ? data.giteaRepoName : null,
    };
    if (typeof data.provisioningState === "string") {
      out.provisioningState = data.provisioningState;
    }
    return out;
  });
}

async function isAssignedToGateway(
  db: Firestore,
  gatewayId: string,
  uid: string,
  data?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const userData =
    data ??
    ((await db.collection("users").doc(uid).get()).data() as Record<string, unknown> | undefined);
  if (!userData || userData.approved !== true) return null;
  return stringAt(userData, "provisioning.openclaw.gatewayId") === gatewayId ? userData : null;
}

async function loadSnapshot(
  db: Firestore,
  uid: string,
  data: Record<string, unknown>,
): Promise<FleetBrokerUserSnapshot | null> {
  const slug = slugFromAssignedUser(data);
  if (!slug || !isValidUsername(slug)) return null;
  const [channels, projects, coachSecret, agentSnap] = await Promise.all([
    collectChannelBindings(db, slug),
    collectProjects(db, slug),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    db.collection("agents").doc(uid).get(),
  ]);
  const coachData = coachSecret.data() as Record<string, unknown> | undefined;
  const agentData = agentSnap.data() as Record<string, unknown> | undefined;
  const name = typeof agentData?.name === "string" ? agentData.name : "";
  const emoji = typeof agentData?.avatarEmoji === "string" ? agentData.avatarEmoji : "";
  const status = stringAt(data, "provisioning.openclaw.status");
  return {
    uid,
    slug,
    tier: stringAt(data, "tier") || stringAt(data, "subscription.tier") || "trial",
    gatewayId: stringAt(data, "provisioning.openclaw.gatewayId"),
    status: status === "provisioning" || status === "complete" ? status : "",
    agentIds: stringArray(readPath(data, "provisioning.openclaw.agentIds")),
    repoUrl: stringAt(data, "provisioning.git.repoUrl"),
    mattermostUserId: stringAt(data, "mattermost.userId") || null,
    customerMmUserId: stringAt(data, "mattermost.userId") || null,
    greetingPosted: Boolean((readPath(data, "provisioning.openclaw.greeting") as { ok?: unknown } | undefined)?.ok),
    channels,
    projects,
    ownerName: stringAt(data, "displayName") || stringAt(data, "username") || slug,
    email: stringAt(data, "email"),
    displayName: stringAt(data, "displayName"),
    lastName: stringAt(data, "lastName"),
    photoURL: stringAt(data, "photoURL"),
    onboardingVibe:
      typeof readPath(data, "onboarding.vibe") === "string"
        ? (readPath(data, "onboarding.vibe") as string)
        : null,
    coachToken: typeof coachData?.personalToken === "string" ? coachData.personalToken : null,
    coachMmUserId:
      typeof coachData?.coachMmUserId === "string" ? coachData.coachMmUserId : null,
    ...(name || emoji ? { coachIdentity: { name, emoji } } : {}),
  };
}

async function findAssignedUidBySlug(
  db: Firestore,
  gatewayId: string,
  slug: string,
): Promise<string | null> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.gatewayId", "==", gatewayId)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    if (data?.approved !== true) continue;
    if (slugFromAssignedUser(data) === slug) return doc.id;
  }
  return null;
}

export function createFleetBrokerRoutes(opts: { db: Firestore } & FleetBrokerRouteDeps): Router {
  const router = Router();
  const { db } = opts;
  const provisionMattermost = opts.provisionMattermost ?? defaultProvisionMattermost;
  const markProvisioningComplete =
    opts.markProvisioningComplete ?? defaultMarkProvisioningComplete;
  const notifyOpsOfSignup = opts.notifyOpsOfSignup ?? defaultNotifyOpsOfSignup;

  router.post("/assigned-users", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const completeOnly = req.body?.completeOnly === true;
    const snap = await db
      .collection("users")
      .where("provisioning.openclaw.gatewayId", "==", bound.gatewayId)
      .get();
    const users: FleetBrokerUserSnapshot[] = [];
    for (const doc of snap.docs) {
      const data = await isAssignedToGateway(db, bound.gatewayId, doc.id, doc.data() as Record<string, unknown>);
      if (!data) continue;
      if (completeOnly && stringAt(data, "provisioning.openclaw.status") !== "complete") {
        continue;
      }
      const snapshot = await loadSnapshot(db, doc.id, data);
      if (snapshot) users.push(snapshot);
    }
    res.json({ users });
  });

  router.post("/uid-for-slug", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
    if (!isValidUsername(slug)) {
      res.status(400).json({ error: "invalid_slug" });
      return;
    }
    const uid = await findAssignedUidBySlug(db, bound.gatewayId, slug);
    if (!uid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ uid });
  });

  router.post("/user-snapshot", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = typeof req.body?.uid === "string" ? req.body.uid : "";
    if (!uid) {
      res.status(400).json({ error: "uid_required" });
      return;
    }
    const data = await isAssignedToGateway(db, bound.gatewayId, uid);
    if (!data) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const snapshot = await loadSnapshot(db, uid, data);
    if (!snapshot) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ user: snapshot });
  });

  router.post("/set-provisioning-status", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const status = objectBody(req).status;
    if (!isProvisioningStatus(status)) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.status": status,
      });
      res.status(204).end();
    });
  });

  router.post("/set-repo-url", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const repoUrl = objectBody(req).repoUrl;
    if (typeof repoUrl !== "string" || repoUrl.length === 0 || repoUrl.length > 2048) {
      res.status(400).json({ error: "invalid_repo_url" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.git.repoUrl": repoUrl,
        "provisioning.git.createdAt": FieldValue.serverTimestamp(),
      });
      res.status(204).end();
    });
  });

  router.post("/provision-mattermost", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      const mmUpdate = await provisionMattermost({
        uid: assigned.uid,
        userData: assigned.data,
      });
      res.json({ mmUpdate });
    });
  });

  router.post("/set-mattermost-fields", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const mmUpdate = recordBodyValue(objectBody(req).mmUpdate);
    if (!mmUpdate) {
      res.status(400).json({ error: "invalid_mm_update" });
      return;
    }
    await runBrokered(res, async () => {
      await markProvisioningComplete({
        uid: assigned.uid,
        userData: assigned.data,
        mmUpdate,
      });
      res.status(204).end();
    });
  });

  router.post("/set-greeting-result", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const result = objectBody(req).result;
    if (!isGreetingResult(result)) {
      res.status(400).json({ error: "invalid_greeting_result" });
      return;
    }
    const greeting = result.ok
      ? { ok: true, jobId: result.jobId, at: FieldValue.serverTimestamp() }
      : { ok: false, error: result.error, at: FieldValue.serverTimestamp() };
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.greeting": greeting,
      });
      res.status(204).end();
    });
  });

  router.post("/set-agent-ids", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const agentIds = validAgentIds(objectBody(req).agentIds);
    if (!agentIds) {
      res.status(400).json({ error: "invalid_agent_ids" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.agentIds": agentIds,
      });
      res.status(204).end();
    });
  });

  router.post("/mounted", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    const mounted = objectBody(req).mounted;
    if (typeof mounted !== "boolean") {
      res.status(400).json({ error: "invalid_mounted" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("users").doc(assigned.uid).update({
        "provisioning.openclaw.mounted": mounted,
      });
      res.status(204).end();
    });
  });

  router.post("/reconcile-error", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    const message = objectBody(req).message;
    if (typeof message !== "string" || message.length === 0) {
      res.status(400).json({ error: "invalid_message" });
      return;
    }
    await runBrokered(res, async () => {
      await db.collection("gateways").doc(assigned.bound.gatewayId).set(
        {
          lastError: {
            slug: assigned.slug,
            message: message.slice(0, 2000),
            at: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );
      res.status(204).end();
    });
  });

  router.post("/clear-reconcile-error", async (req, res) => {
    const assigned = await requireAssignedSlug(db, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      const ref = db.collection("gateways").doc(assigned.bound.gatewayId);
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        const current = snap.data()?.lastError as { slug?: string } | null | undefined;
        if (current && current.slug === assigned.slug) {
          txn.set(ref, { lastError: null }, { merge: true });
        }
      });
      res.status(204).end();
    });
  });

  router.post("/notify-signup", async (req, res) => {
    const assigned = await requireAssignedUser(db, req, res);
    if (!assigned) return;
    await runBrokered(res, async () => {
      await notifyOpsOfSignup({ uid: assigned.uid, userData: assigned.data });
      res.status(204).end();
    });
  });

  return router;
}
