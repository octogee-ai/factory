import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Write = {
  path: string;
  data?: Record<string, unknown>;
  deleted?: true;
};

const h = vi.hoisted(() => ({
  uid: "uid-1",
  writes: [] as Write[],
  encryptSecret: vi.fn(),
}));

function docRef(path: string) {
  return {
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${path}/${name}/${id}`),
    }),
    set: async (data: Record<string, unknown>) => {
      h.writes.push({ path, data });
    },
    delete: async () => {
      h.writes.push({ path, deleted: true });
    },
  };
}

vi.mock("../middleware/auth.js", () => ({
  requireActiveAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuthenticatedUid: (req: { uid?: string }, _res: unknown, next: () => void) => {
    req.uid = h.uid;
    next();
  },
}));

vi.mock("../lib/db.js", () => ({
  db: {
    collection: (path: string) => ({
      doc: (id: string) => docRef(`${path}/${id}`),
    }),
  },
  FieldValue: {
    serverTimestamp: () => "SERVER_TS",
  },
}));

vi.mock("../lib/kms.js", () => ({
  encryptSecret: (secret: string) => h.encryptSecret(secret),
}));

const { default: integrationRoutes } = await import("../routes/integrations.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/integrations", integrationRoutes);
  return a;
}

beforeEach(() => {
  h.uid = "uid-1";
  h.writes.length = 0;
  h.encryptSecret.mockReset().mockImplementation(async (secret: string) => `encrypted:${secret}`);
});

describe("POST /api/integrations/imap", () => {
  it("rejects missing required fields before encryption or writes", async () => {
    const res = await request(app())
      .post("/api/integrations/imap")
      .send({ email: "builder@example.com", imapHost: "imap.example.com" })
      .expect(400);

    expect(res.body).toEqual({ error: "Missing required fields" });
    expect(h.encryptSecret).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("stores IMAP metadata separately from encrypted secrets with default ports and SMTP host", async () => {
    const res = await request(app())
      .post("/api/integrations/imap")
      .send({
        email: "builder@example.com",
        imapHost: "imap.example.com",
        username: "builder",
        password: "plain-password",
      })
      .expect(200);

    expect(res.body).toEqual({ success: true });
    expect(h.encryptSecret).toHaveBeenCalledWith("plain-password");
    expect(h.writes).toEqual([
      {
        path: "users/uid-1/integrations/imap",
        data: {
          provider: "imap",
          status: "pending",
          email: "builder@example.com",
          imap: { host: "imap.example.com", port: 993, username: "builder" },
          smtp: { host: "smtp.example.com", port: 587, username: "builder" },
          connectedAt: "SERVER_TS",
          updatedAt: "SERVER_TS",
        },
      },
      {
        path: "users/uid-1/secrets/imap",
        data: {
          provider: "imap",
          imap: { encryptedPassword: "encrypted:plain-password" },
          smtp: { encryptedPassword: "encrypted:plain-password" },
          updatedAt: "SERVER_TS",
        },
      },
    ]);
    expect(JSON.stringify(h.writes[0].data)).not.toContain("plain-password");
  });
});

describe("POST /api/integrations/twilio", () => {
  it("stores Twilio account metadata separately from the encrypted auth token", async () => {
    await request(app())
      .post("/api/integrations/twilio")
      .send({
        accountSid: "AC123",
        authToken: "twilio-secret",
        fromNumber: "+15551234567",
      })
      .expect(200, { success: true });

    expect(h.encryptSecret).toHaveBeenCalledWith("twilio-secret");
    expect(h.writes).toEqual([
      {
        path: "users/uid-1/integrations/twilio",
        data: {
          provider: "twilio",
          status: "pending",
          twilio: { accountSid: "AC123", fromNumber: "+15551234567" },
          connectedAt: "SERVER_TS",
          updatedAt: "SERVER_TS",
        },
      },
      {
        path: "users/uid-1/secrets/twilio",
        data: {
          provider: "twilio",
          twilio: { encryptedAuthToken: "encrypted:twilio-secret" },
          updatedAt: "SERVER_TS",
        },
      },
    ]);
    expect(JSON.stringify(h.writes[0].data)).not.toContain("twilio-secret");
  });
});

describe("POST /api/integrations/disconnect", () => {
  it("rejects invalid services before writes", async () => {
    await request(app())
      .post("/api/integrations/disconnect")
      .send({ service: "github" })
      .expect(400, { error: "Invalid service: github" });

    expect(h.writes).toEqual([]);
  });

  it("marks valid services disconnected and deletes the matching secret doc", async () => {
    await request(app())
      .post("/api/integrations/disconnect")
      .send({ service: "whatsapp" })
      .expect(200, { success: true });

    expect(h.writes).toEqual([
      {
        path: "users/uid-1/integrations/whatsapp",
        data: {
          provider: "whatsapp",
          status: "disconnected",
          updatedAt: "SERVER_TS",
        },
      },
      {
        path: "users/uid-1/secrets/whatsapp",
        deleted: true,
      },
    ]);
  });
});
