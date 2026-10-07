import { describe, it, expect, vi } from "vitest";
import {
  shouldForwardFrame,
  deriveExpectedAgentId,
  resolveExpectedAgentId,
  ExpectedAgentIdError,
  sanitizeActivityFrame,
} from "../openclaw/frame-filter.js";

const EXPECTED = "octogee-dave-coach";
const ctx = { expectedAgentId: EXPECTED };

describe('read-only native Activity scope', () => {
  const sessionKey = `agent:${EXPECTED}:mattermost:group:${'c'.repeat(26)}`;
  const scope = { ...ctx, sessionKey };
  it.each([undefined, null, true, 1, 'malformed', []].map(data => ({ data })))('drops malformed native Activity data $data before sanitizing', ({ data }) => {
    for (const event of ['agent', 'session.tool']) {
      const raw = eventFrame(event, { sessionKey, stream: 'tool', data });
      const decision = shouldForwardFrame(raw, scope);
      expect(decision).toEqual({ forward: false, reason: 'invalid-payload' });
      expect(() => { if (decision.forward) sanitizeActivityFrame(raw); }).not.toThrow();
    }
  });
  it('redacts structured tool arguments and results before browser transmission without changing native identity', () => {
    const raw = eventFrame('agent', {
      sessionKey, runId: 'r'.repeat(45), seq: 1, ts: 1000, stream: 'tool',
      data: { phase: 'start', name: 'exec', toolCallId: 't'.repeat(45),
        args: { token: 'short-secret', command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"' },
        result: { content: [{ type: 'text', text: 'github_pat_abcdefghijklmnopqrstuvwxyz123456789' }] },
        extra: { private: 'not a display field' },
      },
    });
    const safe = sanitizeActivityFrame(raw);
    expect(safe).not.toContain('short-secret');
    expect(safe).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(safe).not.toContain('not a display field');
    expect(JSON.parse(safe).payload).toMatchObject({ sessionKey, runId: 'r'.repeat(45), data: { toolCallId: 't'.repeat(45), name: 'exec', args: { token: '[redacted]' } } });
  });
  it('allows only native tool/lifecycle/plan events in the selected channel or its thread', () => {
    for (const key of [sessionKey, `${sessionKey}:thread:${'r'.repeat(26)}`]) {
      expect(shouldForwardFrame(eventFrame('session.tool', { sessionKey: key, stream: 'tool', data: { phase: 'start' } }), scope).forward).toBe(true);
    }
    for (const key of [sessionKey + 'evil', sessionKey.replace('c'.repeat(26), 'd'.repeat(26)), `agent:${EXPECTED}:main`, `${sessionKey}:thread:untrusted`]) {
      expect(shouldForwardFrame(eventFrame('agent', { sessionKey: key, stream: 'tool' }), scope).forward).toBe(false);
    }
    expect(shouldForwardFrame(eventFrame('agent', { sessionKey, stream: 'assistant' }), scope).forward).toBe(false);
    expect(shouldForwardFrame(eventFrame('session.message', { sessionKey, message: 'private transcript' }), scope).forward).toBe(false);
  });
  it('does not pass RPC snapshots, unparsed frames, health or global metadata', () => {
    for (const raw of ['invalid', JSON.stringify({ type: 'res', id: 'list', ok: true, payload: { sessions: ['foreign'] } }), eventFrame('health', { agents: ['foreign'] }), eventFrame('sessions.changed', { sessionKey, stream: 'tool' }), eventFrame('tick', {}), eventFrame('shutdown', { restart: true })]) {
      expect(shouldForwardFrame(raw, scope).forward).toBe(false);
    }
  });
});

function eventFrame(event: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type: "event", event, payload });
}

describe("shouldForwardFrame — per-user event scoping (#728)", () => {
  describe("agent event class", () => {
    it("forwards agent events whose sessionKey matches the expected agentId", () => {
      const frame = eventFrame("agent", {
        runId: "run-1",
        sessionKey: `agent:${EXPECTED}:default`,
        stream: "assistant",
        data: { text: "hello" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: true,
        reason: "matched-identity",
      });
    });

    it("drops agent events whose sessionKey belongs to another user", () => {
      const frame = eventFrame("agent", {
        runId: "run-2",
        sessionKey: "agent:octogee-jdog-coach:default",
        stream: "assistant",
        data: { text: "secret-for-jdog-only" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });

    it("drops agent events with no sessionKey (cannot establish identity)", () => {
      const frame = eventFrame("agent", {
        runId: "run-3",
        stream: "assistant",
        data: { text: "hi" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "missing-identity",
      });
    });

    it("drops events tagged with a different agent in the same user (sub-agent NOT auto-trusted)", () => {
      const frame = eventFrame("agent", {
        runId: "run-sub",
        sessionKey: "agent:octogee-dave-research:default",
        stream: "assistant",
        data: { text: "search results" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });

    it("does not match a different user whose slug shares a single-token prefix", () => {
      const frame = eventFrame("agent", {
        runId: "run-4",
        sessionKey: "agent:octogee-davekins-coach:default",
        stream: "assistant",
        data: { text: "secret-for-davekins" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });

    it("does not match a different user whose hyphenated slug shares a token (regression for review P0)", () => {
      const hyphenatedCtx = { expectedAgentId: "octogee-bloom-marketing-coach" };
      const frame = eventFrame("agent", {
        runId: "run-hyphen",
        sessionKey: "agent:octogee-bloom-other-coach:default",
        stream: "assistant",
        data: { text: "secret-for-bloom-other" },
      });
      expect(shouldForwardFrame(frame, hyphenatedCtx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });

    it("forwards events for the same hyphenated-slug user (regression for review P0)", () => {
      const hyphenatedCtx = { expectedAgentId: "octogee-bloom-marketing-coach" };
      const frame = eventFrame("agent", {
        runId: "run-hyphen-self",
        sessionKey: "agent:octogee-bloom-marketing-coach:default",
        stream: "assistant",
        data: { text: "ok" },
      });
      expect(shouldForwardFrame(frame, hyphenatedCtx)).toEqual({
        forward: true,
        reason: "matched-identity",
      });
    });
  });

  describe("chat event class", () => {
    it("forwards chat events whose sessionKey matches", () => {
      const frame = eventFrame("chat", {
        sessionKey: `agent:${EXPECTED}:default`,
        state: "delta",
        message: { content: [{ text: "typing..." }] },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: true,
        reason: "matched-identity",
      });
    });

    it("drops chat events with another user's sessionKey", () => {
      const frame = eventFrame("chat", {
        sessionKey: "agent:octogee-jdog-coach:default",
        state: "final",
        message: { content: [{ text: "secret message body" }] },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });

    it("drops chat.side_result with mismatched sessionKey", () => {
      const frame = eventFrame("chat.side_result", {
        sessionKey: "agent:octogee-jdog-coach:default",
        result: "secret",
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });
  });

  describe("session.* event classes (per OpenClaw EVENT_SCOPE_GUARDS)", () => {
    it.each(["sessions.changed", "session.message", "session.tool"])(
      "forwards %s when sessionKey matches expected agent",
      (event) => {
        const frame = eventFrame(event, {
          sessionKey: `agent:${EXPECTED}:default`,
          some: "payload",
        });
        expect(shouldForwardFrame(frame, ctx)).toEqual({
          forward: true,
          reason: "matched-identity",
        });
      },
    );

    it.each(["sessions.changed", "session.message", "session.tool"])(
      "drops %s when sessionKey belongs to another user",
      (event) => {
        const frame = eventFrame(event, {
          sessionKey: "agent:octogee-jdog-coach:default",
          some: "payload",
        });
        expect(shouldForwardFrame(frame, ctx)).toEqual({
          forward: false,
          reason: "identity-mismatch",
        });
      },
    );
  });

  describe("approval event classes", () => {
    it("forwards exec.approval.requested for the expected user", () => {
      const frame = eventFrame("exec.approval.requested", {
        approvalId: "ap-1",
        sessionKey: `agent:${EXPECTED}:default`,
        request: { command: "ls" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: true,
        reason: "matched-identity",
      });
    });

    it("drops exec.approval.requested for a different user", () => {
      const frame = eventFrame("exec.approval.requested", {
        approvalId: "ap-2",
        sessionKey: "agent:octogee-jdog-coach:default",
        request: { command: "rm -rf /" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });

    it("drops plugin.approval.resolved for a different user", () => {
      const frame = eventFrame("plugin.approval.resolved", {
        approvalId: "ap-3",
        sessionKey: "agent:octogee-jdog-coach:default",
        decision: "approved",
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "identity-mismatch",
      });
    });
  });

  describe("system event classes (gateway-wide)", () => {
    it.each([
      "heartbeat",
      "health",
      "tick",
      "cron",
      "presence",
      "shutdown",
      "update.available",
      "voicewake.changed",
      "talk.mode",
      "device.pair.requested",
      "device.pair.resolved",
      "node.pair.requested",
      "node.pair.resolved",
    ])("forwards %s events unconditionally", (event) => {
      const frame = eventFrame(event, { ts: 1234567890 });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: true,
        reason: "system-event",
      });
    });
  });

  describe("non-event frames", () => {
    it("forwards response frames (type: 'res') — per-connection, not broadcast", () => {
      const frame = JSON.stringify({
        type: "res",
        id: 1,
        result: { runId: "run-1" },
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: true,
        reason: "non-event-frame",
      });
    });

    it("forwards request frames (type: 'req') — server→client RPC", () => {
      const frame = JSON.stringify({
        type: "req",
        id: 1,
        method: "ping",
        params: {},
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: true,
        reason: "non-event-frame",
      });
    });

    it("forwards any other top-level type as non-event (defense for future protocol additions)", () => {
      const frame = JSON.stringify({ type: "future-thing", payload: {} });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: true,
        reason: "non-event-frame",
      });
    });
  });

  describe("unknown event classes (fail-closed)", () => {
    it("drops events whose class isn't in the per-user or system allowlist", () => {
      const frame = eventFrame("brand.new.event", {
        sessionKey: `agent:${EXPECTED}:default`,
      });
      expect(shouldForwardFrame(frame, ctx)).toEqual({
        forward: false,
        reason: "unknown-event-class",
      });
    });
  });

  describe("deriveExpectedAgentId (pure)", () => {
    it("returns octogee-{username}-coach when username is set", () => {
      expect(deriveExpectedAgentId("uid-1", { username: "dave" })).toBe(
        "octogee-dave-coach",
      );
    });

    it("falls back to defaultWorkspaceId when username is unset", () => {
      expect(
        deriveExpectedAgentId("uid-1", { defaultWorkspaceId: "smoke-and-fire" }),
      ).toBe("octogee-smoke-and-fire-coach");
    });

    it("prefers username over defaultWorkspaceId when both are present", () => {
      expect(
        deriveExpectedAgentId("uid-1", {
          username: "dave",
          defaultWorkspaceId: "wrong",
        }),
      ).toBe("octogee-dave-coach");
    });

    it("throws ExpectedAgentIdError when neither field is set", () => {
      expect(() => deriveExpectedAgentId("uid-bare", { email: "a@b.c" })).toThrow(
        ExpectedAgentIdError,
      );
    });

    it("preserves hyphens in the slug (works with hyphenated usernames)", () => {
      expect(
        deriveExpectedAgentId("uid-1", { username: "bloom-marketing" }),
      ).toBe("octogee-bloom-marketing-coach");
    });
  });

  describe("resolveExpectedAgentId (db wrapper)", () => {
    function fakeDb(userData: Record<string, unknown> | null) {
      return {
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({
            exists: userData !== null,
            data: () => userData ?? undefined,
          })),
        })),
      } as any;
    }

    it("returns octogee-{username}-coach when username is set", async () => {
      const db = fakeDb({ username: "dave" });
      await expect(resolveExpectedAgentId(db, "uid-1")).resolves.toBe(
        "octogee-dave-coach",
      );
    });

    it("falls back to defaultWorkspaceId when username is unset", async () => {
      const db = fakeDb({ defaultWorkspaceId: "smoke-and-fire" });
      await expect(resolveExpectedAgentId(db, "uid-1")).resolves.toBe(
        "octogee-smoke-and-fire-coach",
      );
    });

    it("prefers username over defaultWorkspaceId when both are present", async () => {
      const db = fakeDb({ username: "dave", defaultWorkspaceId: "wrong" });
      await expect(resolveExpectedAgentId(db, "uid-1")).resolves.toBe(
        "octogee-dave-coach",
      );
    });

    it("throws ExpectedAgentIdError when the user doc doesn't exist", async () => {
      const db = fakeDb(null);
      await expect(resolveExpectedAgentId(db, "uid-missing")).rejects.toThrow(
        ExpectedAgentIdError,
      );
    });

    it("throws ExpectedAgentIdError when neither username nor defaultWorkspaceId is set", async () => {
      const db = fakeDb({ email: "a@b.c" });
      await expect(resolveExpectedAgentId(db, "uid-bare")).rejects.toThrow(
        ExpectedAgentIdError,
      );
    });
  });

  describe("malformed input", () => {
    it("forwards unparseable frames (binary blobs, invalid JSON)", () => {
      expect(shouldForwardFrame("not-json{{", ctx)).toEqual({
        forward: true,
        reason: "unparseable",
      });
    });

    it("forwards JSON values that aren't event-shaped objects", () => {
      expect(shouldForwardFrame("[1,2,3]", ctx)).toEqual({
        forward: true,
        reason: "non-event-frame",
      });
      expect(shouldForwardFrame("null", ctx)).toEqual({
        forward: true,
        reason: "non-event-frame",
      });
    });
  });
});
