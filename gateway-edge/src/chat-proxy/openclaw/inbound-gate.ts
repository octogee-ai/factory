import { PER_USER_EVENTS } from './frame-filter.js';

export interface GateState {
  expectedAgentId: string;
  observedRunIds: Set<string>;
  observedApprovalIds: Set<string>;
  pendingApprovalSubscribeRequests: Map<string, string>;
}

export type InboundReason =
  | 'allowed'
  | 'binary'
  | 'oversized'
  | 'unparseable'
  | 'wrong-type'
  | 'method-not-allowlisted'
  | 'missing-required-param'
  | 'agent-id-mismatch'
  | 'session-key-mismatch'
  | 'unsupported-param'
  | 'invalid-param'
  | 'run-id-not-observed'
  | 'approval-id-not-observed';

export interface InboundDecision {
  accept: boolean;
  reason: InboundReason;
}

const ALLOWED_METHODS = new Set([
  'sessions.list',
  'sessions.subscribe',
  'sessions.messages.subscribe',
  'sessions.messages.unsubscribe',
  'chat.history',
  'chat.abort',
  'exec.approval.resolve',
  'plugin.approval.resolve',
]);

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_OBSERVED = 500;
const MAX_PENDING_APPROVAL_SUBSCRIPTIONS = 100;
const MAX_REQUEST_ID_CHARS = 256;
const MAX_SESSION_KEY_CHARS = 2_048;
const MAX_SESSION_LIST_LIMIT = 200;
const MAX_SESSION_LIST_OFFSET = 10_000;
const MAX_ACTIVE_MINUTES = 525_600;
const MAX_QUERY_CHARS = 256;
const MAX_HISTORY_LIMIT = 200;
const MAX_HISTORY_OFFSET = 100_000;
const MAX_HISTORY_CURSOR_CHARS = 4_096;
const MAX_HISTORY_ID_CHARS = 256;
const MAX_HISTORY_CHARS = 500_000;

const SESSION_LIST_PARAMS = new Set([
  'agentId',
  'limit',
  'offset',
  'activeMinutes',
  'requireLastInteraction',
  'sortBy',
  'includeGlobal',
  'includeUnknown',
  'configuredAgentsOnly',
  'includeDerivedTitles',
  'includeLastMessage',
  'label',
  'boardFace',
  'spawnedBy',
  'search',
  'archived',
]);

const SESSION_MESSAGE_SUBSCRIBE_PARAMS = new Set(['key', 'agentId', 'includeApprovals']);
const SESSION_MESSAGE_UNSUBSCRIBE_PARAMS = new Set(['key', 'agentId']);
const CHAT_HISTORY_PARAMS = new Set([
  'sessionKey',
  'agentId',
  'cursor',
  'limit',
  'offset',
  'messageId',
  'sessionId',
  'maxChars',
]);

export function createGateState(expectedAgentId: string): GateState {
  return {
    expectedAgentId,
    observedRunIds: new Set<string>(),
    observedApprovalIds: new Set<string>(),
    pendingApprovalSubscribeRequests: new Map<string, string>(),
  };
}

export function evaluateInboundFrame(
  frame: string | Buffer,
  isBinary: boolean,
  state: GateState,
): InboundDecision {
  if (isBinary) return reject('binary');

  const text = typeof frame === 'string' ? frame : frame.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) return reject('oversized');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject('unparseable');
  }
  if (!isRecord(parsed)) return reject('unparseable');

  if (parsed.type !== 'req' || typeof parsed.method !== 'string') return reject('wrong-type');

  const method = parsed.method;
  if (!ALLOWED_METHODS.has(method)) return reject('method-not-allowlisted');

  const params = isRecord(parsed.params) ? parsed.params : {};

  if (method === 'sessions.list' || method === 'sessions.subscribe') {
    return evaluateSessionList(params, state);
  }

  if (method === 'sessions.messages.subscribe' || method === 'sessions.messages.unsubscribe') {
    return evaluateSessionMessageSubscription(method, params, parsed.id, state);
  }

  if (method === 'chat.history') {
    return evaluateChatHistory(params, state);
  }

  const sessionDecision = evaluateSessionKey(params, state);
  if (sessionDecision) return sessionDecision;

  if (method === 'chat.abort') {
    return evaluateRunAbort(params, state);
  }

  if (method === 'exec.approval.resolve' || method === 'plugin.approval.resolve') {
    return evaluateApprovalResolve(params, state);
  }

  return reject('method-not-allowlisted');
}

function evaluateSessionList(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision {
  const agentDecision = evaluateRequiredAgentId(params, state);
  if (agentDecision) return agentDecision;
  if (hasUnsupportedParams(params, SESSION_LIST_PARAMS)) return reject('unsupported-param');

  if (!isOptionalIntegerInRange(params.limit, 1, MAX_SESSION_LIST_LIMIT)) {
    return reject('invalid-param');
  }
  if (!isOptionalIntegerInRange(params.offset, 0, MAX_SESSION_LIST_OFFSET)) {
    return reject('invalid-param');
  }
  if (!isOptionalIntegerInRange(params.activeMinutes, 1, MAX_ACTIVE_MINUTES)) {
    return reject('invalid-param');
  }
  if (!isOptionalBoolean(params.requireLastInteraction)) return reject('invalid-param');
  if (!isOptionalEnum(params.sortBy, ['updatedAt', 'lastInteractionAt'])) {
    return reject('invalid-param');
  }
  if (params.includeGlobal !== undefined && params.includeGlobal !== false) {
    return reject('invalid-param');
  }
  if (params.includeUnknown !== undefined && params.includeUnknown !== false) {
    return reject('invalid-param');
  }
  for (const field of [
    params.configuredAgentsOnly,
    params.includeDerivedTitles,
    params.includeLastMessage,
  ]) {
    if (!isOptionalBoolean(field)) return reject('invalid-param');
  }
  if (!isOptionalString(params.label, MAX_QUERY_CHARS, false)) return reject('invalid-param');
  if (!isOptionalEnum(params.boardFace, ['chat', 'dashboard'])) return reject('invalid-param');
  if (!isOptionalString(params.search, MAX_QUERY_CHARS, true)) return reject('invalid-param');
  if (!isOptionalArchived(params.archived)) return reject('invalid-param');

  if (params.spawnedBy !== undefined) {
    const lineageDecision = evaluateOwnedSessionKey(params.spawnedBy, state);
    if (lineageDecision) return lineageDecision;
  }

  return allow();
}

function evaluateSessionMessageSubscription(
  method: 'sessions.messages.subscribe' | 'sessions.messages.unsubscribe',
  params: Record<string, unknown>,
  requestId: unknown,
  state: GateState,
): InboundDecision {
  const allowedParams = method === 'sessions.messages.subscribe'
    ? SESSION_MESSAGE_SUBSCRIBE_PARAMS
    : SESSION_MESSAGE_UNSUBSCRIBE_PARAMS;
  if (hasUnsupportedParams(params, allowedParams)) {
    return reject('unsupported-param');
  }
  const agentDecision = evaluateOptionalAgentId(params, state);
  if (agentDecision) return agentDecision;
  const keyDecision = evaluateOwnedSessionKey(params.key, state);
  if (keyDecision) return keyDecision;

  if (params.includeApprovals !== undefined) {
    if (method !== 'sessions.messages.subscribe' || params.includeApprovals !== true) {
      return reject('unsupported-param');
    }
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return reject('missing-required-param');
    }
    if (requestId.length > MAX_REQUEST_ID_CHARS) return reject('invalid-param');
    if (state.pendingApprovalSubscribeRequests.has(requestId)) return reject('invalid-param');
    addCappedMap(
      state.pendingApprovalSubscribeRequests,
      requestId,
      params.key as string,
      MAX_PENDING_APPROVAL_SUBSCRIPTIONS,
    );
  }
  return allow();
}

function evaluateChatHistory(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision {
  if (hasUnsupportedParams(params, CHAT_HISTORY_PARAMS)) return reject('unsupported-param');
  const agentDecision = evaluateOptionalAgentId(params, state);
  if (agentDecision) return agentDecision;
  const keyDecision = evaluateOwnedSessionKey(params.sessionKey, state);
  if (keyDecision) return keyDecision;

  if (!isOptionalString(params.cursor, MAX_HISTORY_CURSOR_CHARS, true)) {
    return reject('invalid-param');
  }
  if (!isOptionalIntegerInRange(params.limit, 1, MAX_HISTORY_LIMIT)) {
    return reject('invalid-param');
  }
  if (!isOptionalIntegerInRange(params.offset, 0, MAX_HISTORY_OFFSET)) {
    return reject('invalid-param');
  }
  if (!isOptionalString(params.messageId, MAX_HISTORY_ID_CHARS, false)) {
    return reject('invalid-param');
  }
  if (!isOptionalString(params.sessionId, MAX_HISTORY_ID_CHARS, false)) {
    return reject('invalid-param');
  }
  if (!isOptionalIntegerInRange(params.maxChars, 1, MAX_HISTORY_CHARS)) {
    return reject('invalid-param');
  }

  return allow();
}

function evaluateRequiredAgentId(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision | null {
  if (params.agentId === undefined || params.agentId === '') {
    return reject('missing-required-param');
  }
  if (params.agentId !== state.expectedAgentId) return reject('agent-id-mismatch');
  return null;
}

function evaluateOptionalAgentId(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision | null {
  if (params.agentId === undefined) return null;
  if (typeof params.agentId !== 'string') return reject('invalid-param');
  if (params.agentId !== state.expectedAgentId) return reject('agent-id-mismatch');
  return null;
}

function evaluateOwnedSessionKey(value: unknown, state: GateState): InboundDecision | null {
  if (value === undefined || value === '') return reject('missing-required-param');
  if (typeof value !== 'string' || value.length > MAX_SESSION_KEY_CHARS) {
    return reject('invalid-param');
  }
  const prefix = `agent:${state.expectedAgentId}:`;
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    return reject('session-key-mismatch');
  }
  return null;
}

function hasUnsupportedParams(params: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(params).some((key) => !allowed.has(key));
}

function isOptionalIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) && Number(value) >= min && Number(value) <= max)
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalString(value: unknown, maxLength: number, allowEmpty: boolean): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length <= maxLength &&
      (allowEmpty || value.length > 0))
  );
}

function isOptionalEnum(value: unknown, values: readonly string[]): boolean {
  return value === undefined || (typeof value === 'string' && values.includes(value));
}

function isOptionalArchived(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean' || value === 'all';
}

function evaluateSessionKey(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision | null {
  const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : undefined;
  if (sessionKey !== undefined && !sessionKey.startsWith(`agent:${state.expectedAgentId}:`)) {
    return reject('session-key-mismatch');
  }
  return null;
}

function evaluateRunAbort(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision {
  const runId = typeof params.runId === 'string' ? params.runId : '';
  if (!runId) return reject('missing-required-param');
  if (!state.observedRunIds.has(runId)) return reject('run-id-not-observed');
  return allow();
}

function evaluateApprovalResolve(
  params: Record<string, unknown>,
  state: GateState,
): InboundDecision {
  const approvalId = typeof params.approvalId === 'string' ? params.approvalId : '';
  if (!approvalId) return reject('missing-required-param');
  if (!state.observedApprovalIds.has(approvalId)) return reject('approval-id-not-observed');
  return allow();
}

export function observeOutboundForState(rawFrame: string, state: GateState): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFrame);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  if (parsed.type === 'res') {
    observeApprovalReplayResponse(parsed, state);
    return;
  }
  if (parsed.type !== 'event' || typeof parsed.event !== 'string') return;
  if (!PER_USER_EVENTS.has(parsed.event)) return;

  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
  if (!sessionKey.startsWith(`agent:${state.expectedAgentId}:`)) return;

  const runId = typeof payload.runId === 'string' ? payload.runId : '';
  if (runId) addCapped(state.observedRunIds, runId);

  const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
  if (approvalId) addCapped(state.observedApprovalIds, approvalId);
}

function observeApprovalReplayResponse(
  response: Record<string, unknown>,
  state: GateState,
): void {
  const requestId = typeof response.id === 'string' ? response.id : '';
  const expectedSessionKey = state.pendingApprovalSubscribeRequests.get(requestId);
  if (!expectedSessionKey) return;
  state.pendingApprovalSubscribeRequests.delete(requestId);
  if (response.ok !== true || !isRecord(response.payload)) return;

  const payload = response.payload;
  if (payload.subscribed !== true || payload.key !== expectedSessionKey) return;
  if (!isRecord(payload.approvalReplay)) return;
  const replay = payload.approvalReplay;
  if (replay.sessionKey !== expectedSessionKey || !Array.isArray(replay.approvals)) return;

  for (const approval of replay.approvals) {
    if (!isRecord(approval)) continue;
    const approvalId = typeof approval.id === 'string' ? approval.id : '';
    if (approvalId) addCapped(state.observedApprovalIds, approvalId);
  }
}

function addCapped(set: Set<string>, value: string): void {
  if (set.has(value)) return;
  if (set.size >= MAX_OBSERVED) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  set.add(value);
}

function addCappedMap<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reject(reason: Exclude<InboundReason, 'allowed'>): InboundDecision {
  return { accept: false, reason };
}

function allow(): InboundDecision {
  return { accept: true, reason: 'allowed' };
}
