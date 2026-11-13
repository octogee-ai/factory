import express from "express";
import { FieldPath } from "firebase-admin/firestore";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { SIMPLE_MODEL_TIERS } from "@octogee/shared/types/agent-models";

const h = vi.hoisted(() => ({
  set: vi.fn(),
  update: vi.fn(),
  triggerSync: vi.fn(),
  systemConfig: {} as Record<string, unknown>,
  deleted: Symbol("deleted field"),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuthenticatedUid: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { uid: "alice-uid", user: { username: "alice", provisioning: { openclaw: { gatewayId: "alice" } } } });
    next();
  },
  requireActiveAccount: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../lib/db.js", () => ({
  db: { doc: (path: string) => ({
    get: async () => ({ data: () => path.endsWith("/system/config") ? h.systemConfig : undefined }),
    set: h.set,
    update: h.update,
  }) },
  FieldValue: { delete: () => h.deleted },
}));
vi.mock("../lib/platform-state.js", () => ({ platformStateStore: {} }));
vi.mock("../lib/byot-sync-trigger.js", () => ({ triggerGatewayModelCredentialSync: h.triggerSync }));
vi.mock("@octogee/shared/types/user-entitlements", () => ({
  userEntitlements: () => ({ policy: () => ({ modelAccess: "catalog" }), previousImageFields: () => ({}), pickInputs: () => ({}) }),
}));

const { default: routes } = await import("../routes/agent-models.js");
const app = express();
app.use(express.json());
app.use(routes);

const coach = "octogee-alice-coach";
const projectCoach = "octogee-alice-proj-demo-coach";
const coachModel = { primary: SIMPLE_MODEL_TIERS.everyday.ref, fallbacks: [] };
const projectModel = { primary: SIMPLE_MODEL_TIERS.hard.ref, fallbacks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  h.systemConfig = { agentModels: { [coach]: coachModel, [projectCoach]: projectModel } };
});

it.each(["put", "delete"] as const)("rejects a model %s for another account before writing or syncing", async method => {
  await request(app)[method]("/octogee-bob-coach").send(coachModel).expect(403);
  expect(h.set).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
  expect(h.triggerSync).not.toHaveBeenCalled();
});

it("updates one coach selection and syncs the project coach's existing selection too", async () => {
  const selection = { primary: SIMPLE_MODEL_TIERS.errands.ref, fallbacks: [] };
  await request(app).put(`/${coach}`).send(selection).expect(200);
  expect(h.set).toHaveBeenCalledWith({ agentModels: { [coach]: selection } }, { merge: true });
  expect(h.triggerSync.mock.calls[0]?.[0].userData.systemConfig.agentModels).toEqual({
    [coach]: selection,
    [projectCoach]: projectModel,
  });
});

it("deletes exactly one agent field and syncs the other selections", async () => {
  await request(app).delete(`/${coach}`).expect(200);
  const [field, value] = h.update.mock.calls[0];
  expect(field).toBeInstanceOf(FieldPath);
  expect(field.isEqual(new FieldPath("agentModels", coach))).toBe(true);
  expect(value).toBe(h.deleted);
  expect(h.triggerSync.mock.calls[0]?.[0].userData.systemConfig.agentModels).toEqual({ [projectCoach]: projectModel });
});
