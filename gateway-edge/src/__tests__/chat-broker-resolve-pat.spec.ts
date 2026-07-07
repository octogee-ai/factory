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
  it("workspace coach agent reads with the BUILDER's PAT and excludes the coach bot's posts", async () => {
    // The workspace agent acts on behalf of the human — the Builder's own MM
    // membership (workspace + project channels) is exactly the context the
    // user's agent should see. The exclusion id is still the coach BOT (the
    // agent's own authored posts), which the builder PAT cannot report as "me".
    const db = dbOf({
      [`users/${UID}/secrets/mattermost`]: { personalToken: "builder-pat" },
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
      pat: "builder-pat",
      excludeMmUserId: "mm-coach-bot",
      // The `unread` direction is the AGENT's catch-up cursor, so it runs under
      // the coach bot's own PAT — MM only serves a user's unread state to that
      // user, and running it under the builder PAT would either 403 (coach id)
      // or silently clobber the HUMAN's unread badges (`me`).
      unread: { pat: "coach-pat", mmUserId: "mm-coach-bot" },
    });
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
      excludeMmUserId: "mm-proj-bot",
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

  it("fails loud when the builder PAT is missing (no admin/coach fallback)", async () => {
    const db = dbOf({
      [`users/${UID}/secrets/coachMattermost`]: {
        personalToken: "coach-pat",
        coachMmUserId: "mm-coach-bot",
      },
    });
    await expect(
      resolveChatIdentity(db, { uid: UID, slug: SLUG, agentId: "octogee-alice-coach" }),
    ).rejects.toMatchObject({ code: "no-builder-pat" });
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
