import { describe, expect, it } from "vitest";
import {
  ChatPatError,
  resolveChatIdentity,
} from "../lib/chat-broker/resolve-pat.js";

type Docs = Record<string, Record<string, unknown> | undefined>;

function dbOf(docs: Docs) {
  return {
    doc: (path: string) => ({
      get: async () => ({ data: () => docs[path] }),
    }),
  };
}

const UID = "uid-1";
const SLUG = "alice";

describe("resolveChatIdentity", () => {
  it("workspace coach agent reads with its own PAT", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "coach-pat",
        coachMmUserId: "mm-coach-bot",
      },
    });
    const identity = await resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-coach",
    });
    expect(identity).toEqual({
      lane: "workspace",
      pat: "coach-pat",
      coachMmUserId: "mm-coach-bot",
      unread: { pat: "coach-pat", mmUserId: "mm-coach-bot" },
    });
  });

  it("lets only the workspace coach retrieve archived project history before the deadline", async () => {
    const db = dbOf({
      [`users/${UID}`]: {
        projectRetention: {
          schemaVersion: 1,
          status: "archived",
          archivedAt: "2026-07-01T00:00:00.000Z",
          deleteAfter: "2099-09-29T00:00:00.000Z",
          warnedAt: null,
        },
      },
      [`users/${UID}/secrets/mattermost`]: { personalToken: "builder-pat" },
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "coach-pat",
        coachMmUserId: "mm-coach-bot",
      },
    });

    await expect(resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-coach",
    })).resolves.toMatchObject({
      lane: "workspace",
      includeArchivedProjectHistory: true,
    });

    await expect(resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-proj-camp-coach",
    })).rejects.toMatchObject({ code: "project-archived" });
  });

  it("stops archived history reads when the retention deadline has passed", async () => {
    const db = dbOf({
      [`users/${UID}`]: {
        projectRetention: {
          schemaVersion: 1,
          status: "archived",
          archivedAt: "2020-01-01T00:00:00.000Z",
          deleteAfter: "2020-03-31T00:00:00.000Z",
          warnedAt: null,
        },
      },
      [`users/${UID}/secrets/mattermost`]: { personalToken: "builder-pat" },
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "coach-pat",
        coachMmUserId: "mm-coach-bot",
      },
    });

    await expect(resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-coach",
    })).resolves.not.toHaveProperty("includeArchivedProjectHistory");
  });

  it("project agent reads with ITS OWN bot PAT (channel membership = the capability boundary)", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/projectAgentMattermost-camp`]: {
        personalToken: "proj-pat",
        mmUserId: "mm-proj-bot",
      },
    });
    const identity = await resolveChatIdentity(db, {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-proj-camp-coach",
    });
    expect(identity).toEqual({
      lane: "project",
      pat: "proj-pat",
      coachMmUserId: "mm-proj-bot",
      unread: { pat: "proj-pat", mmUserId: "mm-proj-bot" },
    });
  });

  it("rejects an agent id whose slug does not match the assigned workspace", async () => {
    await expect(
      resolveChatIdentity(dbOf({}), {
        uid: UID,
        slug: SLUG,
        agentId: "octogee-bob-coach",
      }),
    ).rejects.toMatchObject({ code: "foreign-agent" });
  });

  it("rejects an unparseable agent id", async () => {
    await expect(
      resolveChatIdentity(dbOf({}), { uid: UID, slug: SLUG, agentId: "not-an-agent" }),
    ).rejects.toMatchObject({ code: "invalid-agent" });
  });

  it("fails loud when the project agent secret is missing — a disabled agent has NO read capability", async () => {
    await expect(
      resolveChatIdentity(dbOf({}), {
        uid: UID,
        slug: SLUG,
        agentId: "octogee-alice-proj-camp-coach",
      }),
    ).rejects.toMatchObject({ code: "no-project-pat" });
  });

  it("fails loud when the coach bot's exclusion id is unavailable", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "builder-pat" },
    });
    await expect(
      resolveChatIdentity(db, { uid: UID, slug: SLUG, agentId: "octogee-alice-coach" }),
    ).rejects.toMatchObject({ code: "no-coach-identity" });
  });

  it("fails loud when the coach bot's PAT is missing (the unread cursor has no credential)", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "builder-pat" },
      [`users/${UID}/secrets/coachMattermost`]: { coachMmUserId: "mm-coach-bot" },
    });
    await expect(
      resolveChatIdentity(db, { uid: UID, slug: SLUG, agentId: "octogee-alice-coach" }),
    ).rejects.toMatchObject({ code: "no-coach-identity" });
  });

  it("errors are ChatPatError instances carrying a bounded code", async () => {
    const err = await resolveChatIdentity(dbOf({}), {
      uid: UID,
      slug: SLUG,
      agentId: "octogee-alice-proj-camp-coach",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatPatError);
  });
});
