import { describe, expect, it } from 'vitest';
import {
  createGateState,
  evaluateInboundFrame,
  observeOutboundForState,
  type GateState,
} from '../inbound-gate.js';

const EXPECTED_AGENT = 'octogee-acme-coach';

function makeState(overrides: Partial<{ runIds: string[]; approvalIds: string[] }> = {}): GateState {
  const state = createGateState(EXPECTED_AGENT);
  for (const r of overrides.runIds ?? []) state.observedRunIds.add(r);
  for (const a of overrides.approvalIds ?? []) state.observedApprovalIds.add(a);
  return state;
}

function frame(method: string, params: unknown): string {
  return JSON.stringify({ type: 'req', id: 'req-1', method, params });
}

describe('evaluateInboundFrame — method allowlist', () => {
  it('rejects binary frames outright', () => {
    const state = makeState();
    const res = evaluateInboundFrame(Buffer.from('anything'), true, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('binary');
  });

  it('rejects oversize frames', () => {
    const state = makeState();
    const big = JSON.stringify({ type: 'req', id: 'x', method: 'chat.abort', params: { runId: 'r1', filler: 'x'.repeat(70_000) } });
    const res = evaluateInboundFrame(big, false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('oversized');
  });

  it('rejects unparseable JSON', () => {
    const state = makeState();
    const res = evaluateInboundFrame('{not json', false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('unparseable');
  });

  it('rejects non-req frames', () => {
    const state = makeState();
    const res = evaluateInboundFrame(JSON.stringify({ type: 'event', event: 'whatever' }), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('wrong-type');
  });

  it('rejects unknown methods (config.get)', () => {
    const state = makeState({ runIds: ['r1'] });
    const res = evaluateInboundFrame(frame('config.get', {}), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('method-not-allowlisted');
  });

  it('rejects unknown methods (config.patch)', () => {
    const state = makeState();
    const res = evaluateInboundFrame(frame('config.patch', { x: 1 }), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('method-not-allowlisted');
  });

  it('rejects unknown methods (channels.status)', () => {
    const state = makeState();
    const res = evaluateInboundFrame(frame('channels.status', {}), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('method-not-allowlisted');
  });

  it('rejects unknown methods (gateway pairing/admin)', () => {
    const state = makeState();
    expect(evaluateInboundFrame(frame('device.pair.request', {}), false, state).accept).toBe(false);
    expect(evaluateInboundFrame(frame('node.pair.request', {}), false, state).accept).toBe(false);
    expect(evaluateInboundFrame(frame('admin.anything', {}), false, state).accept).toBe(false);
  });
});

describe('evaluateInboundFrame — scoped session reads', () => {
  it.each(['sessions.list', 'sessions.subscribe'])(
    '%s accepts a bounded query for this agent',
    (method) => {
      const state = makeState();
      const res = evaluateInboundFrame(
        frame(method, {
          agentId: EXPECTED_AGENT,
          limit: 200,
          offset: 25,
          activeMinutes: 60,
          requireLastInteraction: true,
          sortBy: 'lastInteractionAt',
          includeGlobal: false,
          includeUnknown: false,
          configuredAgentsOnly: true,
          includeDerivedTitles: true,
          includeLastMessage: true,
          label: 'coach',
          boardFace: 'chat',
          spawnedBy: `agent:${EXPECTED_AGENT}:parent`,
          search: 'mattermost',
          archived: 'all',
        }),
        false,
        state,
      );

      expect(res).toEqual({ accept: true, reason: 'allowed' });
    },
  );

  it.each(['sessions.list', 'sessions.subscribe'])('%s requires the expected agentId', (method) => {
    const state = makeState();

    expect(evaluateInboundFrame(frame(method, { limit: 100 }), false, state)).toEqual({
      accept: false,
      reason: 'missing-required-param',
    });
    expect(
      evaluateInboundFrame(
        frame(method, { agentId: 'octogee-other-coach', limit: 100 }),
        false,
        state,
      ),
    ).toEqual({ accept: false, reason: 'agent-id-mismatch' });
  });

  it.each(['sessions.list', 'sessions.subscribe'])(
    '%s rejects unbounded or malformed query values',
    (method) => {
      const state = makeState();
      for (const params of [
        { agentId: EXPECTED_AGENT, limit: 201 },
        { agentId: EXPECTED_AGENT, offset: -1 },
        { agentId: EXPECTED_AGENT, activeMinutes: 0 },
        { agentId: EXPECTED_AGENT, sortBy: 'createdAt' },
        { agentId: EXPECTED_AGENT, includeGlobal: true },
        { agentId: EXPECTED_AGENT, includeUnknown: true },
        { agentId: EXPECTED_AGENT, label: 'x'.repeat(257) },
        { agentId: EXPECTED_AGENT, search: 'x'.repeat(257) },
        { agentId: EXPECTED_AGENT, archived: 'yes' },
      ]) {
        expect(evaluateInboundFrame(frame(method, params), false, state)).toEqual({
          accept: false,
          reason: 'invalid-param',
        });
      }
    },
  );

  it.each(['sessions.list', 'sessions.subscribe'])(
    '%s rejects unsupported selectors and cross-agent lineage',
    (method) => {
      const state = makeState();

      expect(
        evaluateInboundFrame(
          frame(method, { agentId: EXPECTED_AGENT, ownerId: 'someone-else' }),
          false,
          state,
        ),
      ).toEqual({ accept: false, reason: 'unsupported-param' });
      expect(
        evaluateInboundFrame(
          frame(method, {
            agentId: EXPECTED_AGENT,
            spawnedBy: 'agent:octogee-other-coach:parent',
          }),
          false,
          state,
        ),
      ).toEqual({ accept: false, reason: 'session-key-mismatch' });
    },
  );
});

describe('evaluateInboundFrame — scoped session transcript subscriptions', () => {
  it.each(['sessions.messages.subscribe', 'sessions.messages.unsubscribe'])(
    '%s accepts a full session key for this agent',
    (method) => {
      const state = makeState();
      expect(
        evaluateInboundFrame(
          frame(method, { key: `agent:${EXPECTED_AGENT}:mattermost:channel-1` }),
          false,
          state,
        ),
      ).toEqual({ accept: true, reason: 'allowed' });
      expect(
        evaluateInboundFrame(
          frame(method, {
            key: `agent:${EXPECTED_AGENT}:mattermost:channel-1`,
            agentId: EXPECTED_AGENT,
          }),
          false,
          state,
        ),
      ).toEqual({ accept: true, reason: 'allowed' });
    },
  );

  it.each(['sessions.messages.subscribe', 'sessions.messages.unsubscribe'])(
    '%s rejects missing, bare, prefix-only, and cross-agent keys',
    (method) => {
      const state = makeState();
      for (const params of [
        {},
        { key: 'main', agentId: EXPECTED_AGENT },
        { key: `agent:${EXPECTED_AGENT}:` },
        { key: 'agent:octogee-other-coach:main' },
      ]) {
        expect(evaluateInboundFrame(frame(method, params), false, state).accept).toBe(false);
      }
    },
  );

  it.each(['sessions.messages.subscribe', 'sessions.messages.unsubscribe'])(
    '%s rejects a conflicting agentId and unknown params',
    (method) => {
      const state = makeState();
      const key = `agent:${EXPECTED_AGENT}:main`;

      expect(
        evaluateInboundFrame(
          frame(method, { key, agentId: 'octogee-other-coach' }),
          false,
          state,
        ),
      ).toEqual({ accept: false, reason: 'agent-id-mismatch' });
      expect(
        evaluateInboundFrame(frame(method, { key, extra: true }), false, state),
      ).toEqual({ accept: false, reason: 'unsupported-param' });
    },
  );

  it('allows sanitized approval replay opt-in only on subscribe', () => {
    const state = makeState();
    expect(
      evaluateInboundFrame(
        frame('sessions.messages.subscribe', {
          key: `agent:${EXPECTED_AGENT}:main`,
          includeApprovals: true,
        }),
        false,
        state,
      ),
    ).toEqual({ accept: true, reason: 'allowed' });

    for (const [method, includeApprovals] of [
      ['sessions.messages.subscribe', false],
      ['sessions.messages.subscribe', 'true'],
      ['sessions.messages.unsubscribe', true],
    ] as const) {
      expect(
        evaluateInboundFrame(
          frame(method, { key: `agent:${EXPECTED_AGENT}:main`, includeApprovals }),
          false,
          state,
        ),
      ).toEqual({ accept: false, reason: 'unsupported-param' });
    }
  });
});

describe('evaluateInboundFrame — chat.history', () => {
  it('accepts a bounded transcript request for this agent session', () => {
    const state = makeState();
    expect(
      evaluateInboundFrame(
        frame('chat.history', {
          sessionKey: `agent:${EXPECTED_AGENT}:mattermost:channel-1`,
          agentId: EXPECTED_AGENT,
          cursor: 'cursor-1',
          limit: 200,
          offset: 0,
          messageId: 'message-1',
          sessionId: 'session-1',
          maxChars: 500_000,
        }),
        false,
        state,
      ),
    ).toEqual({ accept: true, reason: 'allowed' });
  });

  it('requires a full session key for this agent', () => {
    const state = makeState();
    for (const params of [
      {},
      { sessionKey: 'main', agentId: EXPECTED_AGENT },
      { sessionKey: `agent:${EXPECTED_AGENT}:` },
      { sessionKey: 'agent:octogee-other-coach:main' },
    ]) {
      expect(evaluateInboundFrame(frame('chat.history', params), false, state).accept).toBe(false);
    }
  });

  it('rejects a conflicting agentId, unsupported params, and values beyond the PWA bounds', () => {
    const state = makeState();
    const sessionKey = `agent:${EXPECTED_AGENT}:main`;

    expect(
      evaluateInboundFrame(
        frame('chat.history', { sessionKey, agentId: 'octogee-other-coach' }),
        false,
        state,
      ),
    ).toEqual({ accept: false, reason: 'agent-id-mismatch' });
    expect(
      evaluateInboundFrame(frame('chat.history', { sessionKey, extra: true }), false, state),
    ).toEqual({ accept: false, reason: 'unsupported-param' });
    for (const params of [
      { sessionKey, limit: 201 },
      { sessionKey, offset: -1 },
      { sessionKey, cursor: 'x'.repeat(4_097) },
      { sessionKey, messageId: 'x'.repeat(257) },
      { sessionKey, sessionId: 'x'.repeat(257) },
      { sessionKey, maxChars: 500_001 },
    ]) {
      expect(evaluateInboundFrame(frame('chat.history', params), false, state)).toEqual({
        accept: false,
        reason: 'invalid-param',
      });
    }
  });
});

describe('evaluateInboundFrame — chat.abort', () => {
  it('accepts when runId is observed', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(frame('chat.abort', { runId: 'run-A' }), false, state);
    expect(res.accept).toBe(true);
    expect(res.reason).toBe('allowed');
  });

  it('rejects when runId is not observed', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(frame('chat.abort', { runId: 'run-B' }), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('run-id-not-observed');
  });

  it('rejects when runId is missing', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(frame('chat.abort', {}), false, state);
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('missing-required-param');
  });

  it('rejects when sessionKey targets a different agent', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(
      frame('chat.abort', { runId: 'run-A', sessionKey: 'agent:octogee-other-coach:s1' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('session-key-mismatch');
  });

  it('accepts when sessionKey targets this agent', () => {
    const state = makeState({ runIds: ['run-A'] });
    const res = evaluateInboundFrame(
      frame('chat.abort', { runId: 'run-A', sessionKey: `agent:${EXPECTED_AGENT}:s1` }),
      false,
      state,
    );
    expect(res.accept).toBe(true);
  });
});

describe('evaluateInboundFrame — approval.resolve', () => {
  it('accepts exec.approval.resolve when approvalId is observed', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { approvalId: 'appr-1', decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(true);
  });

  it('accepts plugin.approval.resolve when approvalId is observed', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('plugin.approval.resolve', { approvalId: 'appr-1', decision: 'denied' }),
      false,
      state,
    );
    expect(res.accept).toBe(true);
  });

  it('rejects when approvalId is not observed', () => {
    const state = makeState({ approvalIds: ['appr-other'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { approvalId: 'appr-1', decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('approval-id-not-observed');
  });

  it('rejects when approvalId is missing', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('missing-required-param');
  });

  it('rejects the legacy browser id field instead of approvalId', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('exec.approval.resolve', { id: 'appr-1', decision: 'approved' }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('missing-required-param');
  });

  it('rejects approval resolution when sessionKey targets a different agent', () => {
    const state = makeState({ approvalIds: ['appr-1'] });
    const res = evaluateInboundFrame(
      frame('plugin.approval.resolve', {
        approvalId: 'appr-1',
        decision: 'approved',
        sessionKey: 'agent:octogee-other-coach:s1',
      }),
      false,
      state,
    );
    expect(res.accept).toBe(false);
    expect(res.reason).toBe('session-key-mismatch');
  });
});

describe('observeOutboundForState — populates observed sets', () => {
  it('extracts runId from per-user event payloads', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, runId: 'run-X' },
    });
    observeOutboundForState(f, state);
    expect(state.observedRunIds.has('run-X')).toBe(true);
  });

  it('extracts approvalId from exec.approval.requested events', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, approvalId: 'appr-X', runId: 'run-Y' },
    });
    observeOutboundForState(f, state);
    expect(state.observedApprovalIds.has('appr-X')).toBe(true);
    expect(state.observedRunIds.has('run-Y')).toBe(true);
  });

  it('extracts approvalId from plugin.approval.requested events', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'plugin.approval.requested',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, approvalId: 'appr-Y' },
    });
    observeOutboundForState(f, state);
    expect(state.observedApprovalIds.has('appr-Y')).toBe(true);
  });

  it('ignores events for other agents (defense in depth)', () => {
    const state = makeState();
    const f = JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: { sessionKey: 'agent:octogee-other-coach:s1', runId: 'run-leak' },
    });
    observeOutboundForState(f, state);
    expect(state.observedRunIds.has('run-leak')).toBe(false);
  });

  it('ignores non-event frames', () => {
    const state = makeState();
    observeOutboundForState(JSON.stringify({ type: 'res', id: 'x', ok: true }), state);
    expect(state.observedRunIds.size).toBe(0);
    expect(state.observedApprovalIds.size).toBe(0);
  });

  it('extracts sanitized replay IDs only from the matching approval subscription response', () => {
    const state = makeState();
    const key = `agent:${EXPECTED_AGENT}:main`;
    expect(
      evaluateInboundFrame(
        frame('sessions.messages.subscribe', { key, includeApprovals: true }),
        false,
        state,
      ),
    ).toEqual({ accept: true, reason: 'allowed' });

    observeOutboundForState(
      JSON.stringify({
        type: 'res',
        id: 'req-1',
        ok: true,
        payload: {
          subscribed: true,
          key,
          approvalReplay: {
            sessionKey: key,
            updatedAtMs: 42,
            truncated: false,
            approvals: [{ id: 'appr-replayed', status: 'pending' }],
          },
        },
      }),
      state,
    );

    expect(state.observedApprovalIds.has('appr-replayed')).toBe(true);
  });

  it('ignores replay payloads that do not match an opted-in request and owned session', () => {
    const state = makeState();
    const key = `agent:${EXPECTED_AGENT}:main`;

    evaluateInboundFrame(
      frame('sessions.messages.subscribe', { key, includeApprovals: true }),
      false,
      state,
    );
    for (const response of [
      {
        type: 'res',
        id: 'another-request',
        ok: true,
        payload: {
          subscribed: true,
          key,
          approvalReplay: { sessionKey: key, approvals: [{ id: 'appr-wrong-request' }] },
        },
      },
      {
        type: 'res',
        id: 'req-1',
        ok: true,
        payload: {
          subscribed: true,
          key: 'agent:octogee-other-coach:main',
          approvalReplay: {
            sessionKey: 'agent:octogee-other-coach:main',
            approvals: [{ id: 'appr-wrong-session' }],
          },
        },
      },
    ]) {
      observeOutboundForState(JSON.stringify(response), state);
    }

    expect(state.observedApprovalIds.size).toBe(0);
  });

  it('consumes a pending replay request on the first response, including failures', () => {
    const state = makeState();
    const key = `agent:${EXPECTED_AGENT}:main`;

    evaluateInboundFrame(
      frame('sessions.messages.subscribe', { key, includeApprovals: true }),
      false,
      state,
    );
    observeOutboundForState(
      JSON.stringify({ type: 'res', id: 'req-1', ok: false, error: { message: 'denied' } }),
      state,
    );
    observeOutboundForState(
      JSON.stringify({
        type: 'res',
        id: 'req-1',
        ok: true,
        payload: {
          subscribed: true,
          key,
          approvalReplay: {
            sessionKey: key,
            approvals: [{ id: 'appr-after-failure' }],
          },
        },
      }),
      state,
    );

    expect(state.observedApprovalIds.has('appr-after-failure')).toBe(false);
  });

  it('does not ingest replay IDs for a plain transcript subscription', () => {
    const state = makeState();
    const key = `agent:${EXPECTED_AGENT}:main`;

    evaluateInboundFrame(frame('sessions.messages.subscribe', { key }), false, state);
    observeOutboundForState(
      JSON.stringify({
        type: 'res',
        id: 'req-1',
        ok: true,
        payload: {
          subscribed: true,
          key,
          approvalReplay: {
            sessionKey: key,
            approvals: [{ id: 'appr-unrequested' }],
          },
        },
      }),
      state,
    );

    expect(state.observedApprovalIds.has('appr-unrequested')).toBe(false);
  });

  it('caps observed sets at 500 entries (oldest evicted)', () => {
    const state = makeState();
    for (let i = 0; i < 600; i++) {
      const f = JSON.stringify({
        type: 'event',
        event: 'chat',
        payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, runId: `run-${i}` },
      });
      observeOutboundForState(f, state);
    }
    expect(state.observedRunIds.size).toBe(500);
    expect(state.observedRunIds.has('run-0')).toBe(false);
    expect(state.observedRunIds.has('run-599')).toBe(true);
  });
});

describe('browser WebSocket authorization boundary', () => {
  it('does not allow arbitrary full-scope upstream methods', () => {
    const state = makeState({ runIds: ['run-X'], approvalIds: ['appr-X'] });
    for (const method of [
      'config.get',
      'config.patch',
      'admin.users.list',
      'operator.secrets.read',
      'device.pair.request',
    ]) {
      expect(evaluateInboundFrame(frame(method, {}), false, state)).toEqual({
        accept: false,
        reason: 'method-not-allowlisted',
      });
    }
  });

  it('requires chat.abort runId to be observed from this agent before accepting', () => {
    const state = makeState();
    const outbound = JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: { sessionKey: `agent:${EXPECTED_AGENT}:s1`, runId: 'run-X' },
    });

    expect(evaluateInboundFrame(frame('chat.abort', { runId: 'run-X' }), false, state)).toEqual({
      accept: false,
      reason: 'run-id-not-observed',
    });

    observeOutboundForState(outbound, state);

    expect(evaluateInboundFrame(frame('chat.abort', { runId: 'run-X' }), false, state)).toEqual({
      accept: true,
      reason: 'allowed',
    });
  });

  it('requires approvalId to be observed from this agent before accepting', () => {
    const state = makeState();
    const outbound = JSON.stringify({
      type: 'event',
      event: 'exec.approval.requested',
      payload: {
        sessionKey: `agent:${EXPECTED_AGENT}:s1`,
        approvalId: 'appr-X',
        runId: 'run-X',
      },
    });

    expect(
      evaluateInboundFrame(
        frame('exec.approval.resolve', { approvalId: 'appr-X', decision: 'approved' }),
        false,
        state,
      ),
    ).toEqual({
      accept: false,
      reason: 'approval-id-not-observed',
    });

    observeOutboundForState(outbound, state);

    expect(
      evaluateInboundFrame(
        frame('exec.approval.resolve', { approvalId: 'appr-X', decision: 'approved' }),
        false,
        state,
      ),
    ).toEqual({
      accept: true,
      reason: 'allowed',
    });
  });

  it('does not learn run or approval IDs from another agent outbound stream', () => {
    const state = makeState();
    observeOutboundForState(
      JSON.stringify({
        type: 'event',
        event: 'exec.approval.requested',
        payload: {
          sessionKey: 'agent:octogee-other-coach:s1',
          approvalId: 'appr-leak',
          runId: 'run-leak',
        },
      }),
      state,
    );

    expect(evaluateInboundFrame(frame('chat.abort', { runId: 'run-leak' }), false, state)).toEqual({
      accept: false,
      reason: 'run-id-not-observed',
    });
    expect(
      evaluateInboundFrame(
        frame('exec.approval.resolve', { approvalId: 'appr-leak', decision: 'approved' }),
        false,
        state,
      ),
    ).toEqual({
      accept: false,
      reason: 'approval-id-not-observed',
    });
  });
});
