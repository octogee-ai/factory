import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAdminUserRoutes, type AdminUserRouterDeps, type UserAccounts } from "./admin-user-router.js";

const READY = {
  slug: "lin",
  provisioning: { status: "complete" },
  openclaw: { status: "complete" },
  accountLifecycle: null,
};

function harness(options: { accounts?: boolean; signIn?: boolean; failGit?: boolean } = {}) {
  const create = vi.fn<UserAccounts["create"]>(async (account) => ({ kind: "created", userId: account.userId }));
  const setChatPassword = vi.fn(async (_username: string, _password: string) => undefined);
  const setGitPassword = vi.fn(async (_slug: string, _password: string) => {
    if (options.failGit) throw new Error("gitea-admin set-password failed: 500");
    return "ws-lin";
  });
  const records = { get: vi.fn(async () => null as unknown), findBySlug: vi.fn(async () => null as unknown) };
  const reservations = new Map<string, { ownerUid: string }>();
  const workspaceRecords = {
    get: vi.fn(async (slug: string) => reservations.get(slug) ?? null),
    put: vi.fn(async (record: { slug: string; ownerUid: string }) => {
      reservations.set(record.slug, record);
    }),
    delete: vi.fn(async (slug: string) => {
      reservations.delete(slug);
    }),
  };
  const workspaces = { records: workspaceRecords };
  const transaction = vi.fn(async (_options: unknown, run: (tx: unknown) => Promise<unknown>) => run({ workspaces }));
  const journal = vi.fn(async (input: Record<string, unknown>) => {
    const result = await (input.action as (claim: { auditId: string }) => Promise<unknown>)({ auditId: "audit-1" });
    return result;
  });
  const deps = {
    store: { users: { records }, workspaces, transaction },
    journal,
    ...(options.accounts === false ? {} : { accounts: { create } }),
    ...(options.signIn === false
      ? {}
      : { signIn: { channels: { setUserPassword: setChatPassword }, git: { setUserPassword: setGitPassword } } }),
  } as unknown as AdminUserRouterDeps;
  const app = express();
  app.use(express.json());
  addAdminUserRoutes(app, deps);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, create, records, workspaceRecords, reservations, journal, setChatPassword, setGitPassword };
}

const ADD = { name: "lin", email: "Lin@Example.com" };

function journalEntry(journal: ReturnType<typeof harness>["journal"]): string {
  const { req: _req, ...entry } = journal.mock.calls[0]![0];
  return JSON.stringify(entry);
}

describe("POST /users", () => {
  it("creates the account with a normalized email and returns the id and operation", async () => {
    const { app, create } = harness();
    const response = await request(app).post("/users").send(ADD);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ userId: expect.stringMatching(/^[0-9a-f]{28}$/), operationId: "audit-1" });
    expect(create).toHaveBeenCalledWith({ userId: response.body.userId, name: "lin", email: "lin@example.com" });
  });

  it("reserves the name for the new user before creating the account", async () => {
    const { app, create, reservations, workspaceRecords } = harness();
    const response = await request(app).post("/users").send(ADD);
    expect(reservations.get("lin")).toMatchObject({ ownerUid: response.body.userId });
    expect(workspaceRecords.put.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
  });

  it("creates nothing when a sign-up reserves the name first", async () => {
    const { app, create, reservations, workspaceRecords } = harness();
    workspaceRecords.get.mockResolvedValueOnce(null);
    workspaceRecords.get.mockResolvedValueOnce({ ownerUid: "signed-up-first" });
    const response = await request(app).post("/users").send(ADD);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("name");
    expect(create).not.toHaveBeenCalled();
    expect(reservations.size).toBe(0);
    expect(workspaceRecords.delete).not.toHaveBeenCalled();
  });

  it("releases the name when the account cannot be created", async () => {
    const taken = harness();
    taken.create.mockResolvedValueOnce({ kind: "taken", field: "email" });
    expect((await request(taken.app).post("/users").send(ADD)).status).toBe(409);
    expect(taken.reservations.size).toBe(0);

    const failing = harness();
    failing.create.mockRejectedValueOnce(new Error("firestore unavailable"));
    expect((await request(failing.app).post("/users").send(ADD)).status).toBe(500);
    expect(failing.reservations.size).toBe(0);
  });

  it("keeps the email out of the journal", async () => {
    const { app, journal } = harness();
    await request(app).post("/users").send(ADD);
    expect(journalEntry(journal)).not.toContain("example.com");
  });

  it.each([
    [{ name: "Not Valid", email: "lin@example.com" }, "invalid name"],
    [{ email: "lin@example.com" }, "invalid name"],
    [{ name: "lin", email: "not-an-address" }, "invalid email"],
    [{ name: "lin", email: "two@@example.com" }, "invalid email"],
    [{ name: "lin", email: "lin@example" }, "invalid email"],
    [{ name: "lin" }, "invalid email"],
  ])("refuses %j", async (body, message) => {
    const { app, create, journal } = harness();
    const response = await request(app).post("/users").send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(message);
    expect(create).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
  });

  it("refuses a name held by a workspace or a user", async () => {
    const byWorkspace = harness();
    byWorkspace.reservations.set("lin", { ownerUid: "other" });
    expect((await request(byWorkspace.app).post("/users").send(ADD)).status).toBe(409);

    const byUser = harness();
    byUser.records.findBySlug.mockResolvedValueOnce({ uid: "other" });
    expect((await request(byUser.app).post("/users").send(ADD)).status).toBe(409);

    expect(byWorkspace.create).not.toHaveBeenCalled();
    expect(byUser.create).not.toHaveBeenCalled();
  });

  it("reports which field the backend found taken", async () => {
    const { app, create } = harness();
    create.mockResolvedValueOnce({ kind: "taken", field: "email" });
    const response = await request(app).post("/users").send(ADD);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("email");
  });

  it("says when the platform has no account backend", async () => {
    const { app } = harness({ accounts: false });
    expect((await request(app).post("/users").send(ADD)).status).toBe(501);
  });
});

describe("POST /users/:uid/one-time-passwords", () => {
  let subject: ReturnType<typeof harness>;
  beforeEach(() => {
    subject = harness();
    subject.records.get.mockResolvedValue(READY);
  });

  it("sets a different password on each system and returns both once, uncached", async () => {
    const response = await request(subject.app).post("/users/user-1/one-time-passwords");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { operationId, chat, git } = response.body;
    expect(operationId).toBe("audit-1");
    expect(chat.username).toBe("lin");
    expect(git.username).toBe("ws-lin");
    expect(chat.password).toHaveLength(24);
    expect(git.password).toHaveLength(24);
    expect(chat.password).not.toBe(git.password);
    expect(subject.setChatPassword).toHaveBeenCalledWith("lin", chat.password);
    expect(subject.setGitPassword).toHaveBeenCalledWith("lin", git.password);
  });

  it("gives the journal no password", async () => {
    const response = await request(subject.app).post("/users/user-1/one-time-passwords");
    const recorded = journalEntry(subject.journal);
    expect(recorded).not.toContain(response.body.chat.password);
    expect(recorded).not.toContain(response.body.git.password);
  });

  it("returns nothing when a system refuses, so the operator runs it again", async () => {
    const failing = harness({ failGit: true });
    failing.records.get.mockResolvedValue(READY);
    const response = await request(failing.app).post("/users/user-1/one-time-passwords");
    expect(response.status).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain("password\":");
    expect(failing.setChatPassword).toHaveBeenCalledOnce();
  });

  it.each([
    ["an unknown user", null, 404],
    ["a user still provisioning", { ...READY, provisioning: { status: "in_progress" } }, 409],
    ["a user with no slug", { ...READY, slug: null }, 409],
    ["a suspended user", { ...READY, accountLifecycle: { status: "pending_deletion" } }, 409],
  ])("refuses %s without touching either system", async (_label, record, status) => {
    subject.records.get.mockResolvedValue(record);
    const response = await request(subject.app).post("/users/user-1/one-time-passwords");
    expect(response.status).toBe(status);
    expect(subject.setChatPassword).not.toHaveBeenCalled();
    expect(subject.setGitPassword).not.toHaveBeenCalled();
    expect(subject.journal).not.toHaveBeenCalled();
  });

  it("says when the platform has no sign-in hosts", async () => {
    const { app } = harness({ signIn: false });
    expect((await request(app).post("/users/user-1/one-time-passwords")).status).toBe(501);
  });
});
