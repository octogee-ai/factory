import type { VoiceMigrationRegistry } from './migration.js';
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { Counter, Gauge, type Registry } from "prom-client";
import { internalFetch } from "@octogee/core/internal-fetch";
import { parseTalkClientMessage, TALK_CAPABILITIES_DEFAULT, type TalkCapabilities, type TalkErrorCode, type TalkServerEvent } from "@octogee/shared/types/voice";
import type { OpenClawRuntimeBroker } from "../chat-proxy/openclaw/runtime-broker.js";
import type { RollRosterUpgradeGate } from "../roll-roster.js";
import { createMattermostBrain, type AgentEventSource } from "./brain.js";
import { createVoiceRelayClient, type VoiceRelayClient } from "@octogee/core/voice-relay-client";
import type { SpeechProbabilityModel } from "./silero-vad.js";
import { NativeTalkSession } from "./native-session.js";
import { TalkSession } from "./talk-session.js";
import { archiveVoiceCall, bindVoiceGrant, endVoiceGrant, postVoiceTurn, resolveVoiceConversation, type VoiceConversation, type VoiceGrantBinding } from "@octogee/core/voice-conversation";
import { interruptNativeVoiceRun } from "./native-control.js";

export const VOICE_WS_PATH_RE = /\/api\/voice\/ws\/([a-f0-9-]{36})$/;
const MAX_CLIENT_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_CLIENT_TEXT_FRAME_BYTES = 16 * 1024;
const VOICE_ARCHIVE_HEADROOM_MS = 20_000;

export const VOICE_NOT_CONFIGURED_MESSAGE = "Voice is not set up on this server yet.";
export const VOICE_RELAY_UNAVAILABLE_MESSAGE = "The voice service is not reachable right now.";
export const VOICE_AGENT_UNAVAILABLE_MESSAGE = "Your Octo is not reachable right now.";
export const VOICE_ENGINE_FAILED_MESSAGE = "The voice engine could not start.";

export interface VoiceWsRouteDeps {
  runtimeBroker: Pick<OpenClawRuntimeBroker, "redeemOpenClawWs">;
  eventSourceForAgent: (agentId: string) => AgentEventSource;
  isAgentReady: (agentId: string) => boolean;
  agentReadinessPollMs?: number;
  upgradeGate: RollRosterUpgradeGate | null;
  isAllowedWsOrigin: (origin: string | undefined) => boolean;
  stripGatewayPrefix: (urlPath: string) => string;
  relayBaseUrl: string;
  createVad: () => Promise<SpeechProbabilityModel>;
  nativeVoiceEnabled?: boolean;
  createNativeSession?: (options: ConstructorParameters<typeof NativeTalkSession>[0]) => NativeTalkSession;
  fetchImpl?: typeof fetch;
  resolveConversation?: typeof resolveVoiceConversation;
  postTurn?: typeof postVoiceTurn;
  archiveCall?: typeof archiveVoiceCall;
  bindGrant?: typeof bindVoiceGrant;
  endGrant?: typeof endVoiceGrant;
  conversationCheckMs?: number;
  createRelayClient?: (gatewayId: string) => VoiceRelayClient;
  registry?: Registry;
  migrationRegistry?: VoiceMigrationRegistry;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface RelayStatus {
  configured: boolean;
  nativeOpenAi?: boolean;
  engines?: { stt: string; tts: string };
  capabilities?: TalkCapabilities;
}

function hasVoiceService(status: RelayStatus, useOpenAiVoice: boolean): boolean {
  return useOpenAiVoice || Boolean(status.configured && status.engines);
}

type VoiceClientSession = TalkSession | NativeTalkSession | null;

function originalVoiceFrame(raw: string, message: ReturnType<typeof parseTalkClientMessage>, session: VoiceClientSession, openAiConfigured: boolean): string {
  if (!(session instanceof TalkSession) || !openAiConfigured) return raw;
  if (message?.type !== 'session.start' && message?.type !== 'settings.update') return raw;
  return JSON.stringify({ ...message, settings: { ...message.settings, voice: '' } });
}

interface RedeemedVoiceTicket {
  uid: string;
  gatewayId: string;
  expectedAgentId: string;
  voiceConversation: { ownerUid: string; workspaceSlug: string; channelId: string; threadRootPostId: string; sessionKey: string };
  voiceGrant: string;
  voiceGrantExpiresAt: number;
}

function nativeVoiceEnabled(deps: VoiceWsRouteDeps): boolean {
  return deps.nativeVoiceEnabled ?? (process.env.GATEWAY_CLASS === "builder" && process.env.OPENCLAW_CONTROL_IDENTITY === "per-user");
}

function grantOptions(deps: VoiceWsRouteDeps) {
  return deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
}

function grantRevoker(deps: VoiceWsRouteDeps, ticket: RedeemedVoiceTicket, log: NonNullable<VoiceWsRouteDeps['log']>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= (deps.endGrant ?? endVoiceGrant)({ voiceGrant: ticket.voiceGrant, ...grantOptions(deps) })
    .then(() => undefined).catch(() => { log('voice grant revocation failed', { gatewayId: ticket.gatewayId }); });
}

function assertConversationScope(conversation: VoiceConversation, ticket: RedeemedVoiceTicket): void {
  const scope = ticket.voiceConversation;
  if (conversation.uid !== ticket.uid || conversation.gatewayId !== ticket.gatewayId || conversation.agentId !== ticket.expectedAgentId ||
    conversation.channelId !== scope.channelId || conversation.threadRootPostId !== scope.threadRootPostId || conversation.workspaceSlug !== scope.workspaceSlug || conversation.sessionKey !== scope.sessionKey) {
    throw new Error('Voice conversation does not match its grant');
  }
}

function assertGrantBinding(binding: VoiceGrantBinding, ticket: RedeemedVoiceTicket, sessionId: string): void {
  assertConversationScope(binding, ticket);
  if (binding.sessionId !== sessionId || !Number.isFinite(binding.expiresAt) || binding.expiresAt <= Date.now() || binding.expiresAt > ticket.voiceGrantExpiresAt) {
    throw new Error('Voice grant binding is invalid');
  }
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

function trimTrailingSlashes(url: string): string {
  let out = url;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

async function readRelayStatus(deps: VoiceWsRouteDeps, gatewayId: string): Promise<RelayStatus | null> {
  try {
    const res = await internalFetch(
      `${trimTrailingSlashes(deps.relayBaseUrl)}/internal/voice/status?gatewayId=${encodeURIComponent(gatewayId)}`,
      { method: "GET" },
      { fetchImpl: deps.fetchImpl, timeoutMs: 5_000 },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as RelayStatus;
    return typeof body.configured === "boolean" ? body : null;
  } catch {
    return null;
  }
}

async function reserveVoiceAdmission(
  deps: VoiceWsRouteDeps,
  redeemed: RedeemedVoiceTicket,
  socket: Duplex,
  handshakes: Counter<'outcome'>,
  end: () => void,
): Promise<(() => void) | null> {
  if (!deps.migrationRegistry) return () => undefined;
  const release = deps.migrationRegistry.begin(redeemed.voiceConversation.workspaceSlug, end);
  if (release) return release;
  handshakes.inc({ outcome: 'fail:migration' });
  refuse(socket, '503 Service Unavailable');
  await grantRevoker(deps, redeemed, deps.log ?? (() => undefined))();
  return null;
}

function nativeVoiceMode(deps: VoiceWsRouteDeps, status: RelayStatus) {
  const useNativeVoice = nativeVoiceEnabled(deps);
  return { useNativeVoice, useOpenAiVoice: useNativeVoice && status.nativeOpenAi === true };
}

export function createVoiceWsUpgradeHandler(deps: VoiceWsRouteDeps) {
  const wss = new WebSocketServer({ noServer: true });
  const log = deps.log ?? (() => undefined);
  const registry = deps.registry;
  const handshakes = new Counter({
    name: "voice_ws_handshake_total",
    help: "Voice Talk WebSocket handshakes by outcome",
    labelNames: ["outcome"] as const,
    ...(registry ? { registers: [registry] } : { registers: [] }),
  });
  const active = new Gauge({
    name: "voice_ws_connections_active",
    help: "Open voice Talk WebSocket connections",
    ...(registry ? { registers: [registry] } : { registers: [] }),
  });

  const admit = async (req: http.IncomingMessage, socket: Duplex): Promise<RedeemedVoiceTicket | null> => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!deps.isAllowedWsOrigin(origin)) {
      handshakes.inc({ outcome: "fail:origin-rejected" });
      refuse(socket, "403 Forbidden");
      return null;
    }
    const urlPath = deps.stripGatewayPrefix((req.url ?? "").split("?")[0]);
    const ticket = VOICE_WS_PATH_RE.exec(urlPath)?.[1] ?? null;
    if (!ticket) {
      handshakes.inc({ outcome: "fail:no-ticket" });
      refuse(socket, "401 Unauthorized");
      return null;
    }
    const redeemed = await redeem(ticket, socket);
    if (!redeemed) return null;
    if (deps.upgradeGate) {
      const verdict = deps.upgradeGate.checkUid(redeemed.voiceConversation.ownerUid);
      if (!verdict.allow) {
        handshakes.inc({ outcome: "fail:roster" });
        deps.upgradeGate.refuse(socket, verdict);
        await grantRevoker(deps, redeemed, log)();
        return null;
      }
    }
    return redeemed;
  };

  const redeem = async (ticket: string, socket: Duplex): Promise<RedeemedVoiceTicket | null> => {
    try {
      const outcome = await deps.runtimeBroker.redeemOpenClawWs(ticket, "voice-ws");
      if (outcome.kind === "redeemed") {
        const { voiceConversation, voiceGrant, voiceGrantExpiresAt } = outcome.redeemed;
        if (!voiceConversation?.sessionKey || typeof voiceGrant !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(voiceGrant) ||
          typeof voiceGrantExpiresAt !== "number" || !Number.isSafeInteger(voiceGrantExpiresAt) || voiceGrantExpiresAt <= Date.now()) {
          throw new Error("Voice ticket grant custody is missing");
        }
        return { ...outcome.redeemed, voiceConversation, voiceGrant, voiceGrantExpiresAt };
      }
      const unauthorized = outcome.kind === "unauthorized";
      handshakes.inc({ outcome: unauthorized ? "fail:unauthorized" : "fail:revision-unavailable" });
      refuse(socket, unauthorized ? "401 Unauthorized" : "503 Service Unavailable");
      return null;
    } catch (err) {
      handshakes.inc({ outcome: "fail:redeem-error" });
      log("voice ws redeem failed", { error: err instanceof Error ? err.message : String(err) });
      refuse(socket, "503 Service Unavailable");
      return null;
    }
  };

  /**
   * Past authentication the browser can only see WebSocket frames, never the
   * handshake status, so a refusal it should show is delivered as a typed error
   * over an accepted socket and then closed.
   */
  const refuseWithError = (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    outcome: string,
    error: { code: TalkErrorCode; message: string },
  ): void => {
    handshakes.inc({ outcome });
    wss.handleUpgrade(req, socket, head, (client) => {
      const event: TalkServerEvent = { type: "error", code: error.code, message: error.message, recoverable: false };
      client.send(JSON.stringify(event), () => client.close(1000, outcome));
    });
  };

  return async (req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const redeemed = await admit(req, socket);
    if (!redeemed) return;
    const migration = { end: () => socket.destroy() };
    const releaseAdmission = await reserveVoiceAdmission(deps, redeemed, socket, handshakes, () => migration.end());
    if (!releaseAdmission) return;
    const revokeGrant = grantRevoker(deps, redeemed, log);
    let attached = false;
    const deadline = setTimeout(() => { socket.destroy(); void revokeGrant(); }, Math.max(0, redeemed.voiceGrantExpiresAt - Date.now()));
    deadline.unref?.();
    try {
      if (!deps.isAgentReady(redeemed.expectedAgentId)) {
        refuseWithError(req, socket, head, "fail:agent-unavailable", {
          code: "internal",
          message: VOICE_AGENT_UNAVAILABLE_MESSAGE,
        });
        return;
      }

      const status = await readRelayStatus(deps, redeemed.gatewayId);
      if (!status) {
        refuseWithError(req, socket, head, "fail:relay-unreachable", { code: "internal", message: VOICE_RELAY_UNAVAILABLE_MESSAGE });
        return;
      }
      const { useNativeVoice, useOpenAiVoice } = nativeVoiceMode(deps, status);
      if (!hasVoiceService(status, useOpenAiVoice)) {
        refuseWithError(req, socket, head, "fail:not-configured", { code: "not_configured", message: VOICE_NOT_CONFIGURED_MESSAGE });
        return;
      }
      const engines = status.engines ?? { stt: "openai:gpt-live-1", tts: "openai:gpt-live-1" };
      const capabilities = status.capabilities ?? TALK_CAPABILITIES_DEFAULT;

      let vad: SpeechProbabilityModel | undefined;
      try {
        if (!useNativeVoice) vad = await deps.createVad();
      } catch (err) {
        log("voice ws vad load failed", { error: err instanceof Error ? err.message : String(err) });
        refuseWithError(req, socket, head, "fail:vad", { code: "internal", message: VOICE_ENGINE_FAILED_MESSAGE });
        return;
      }

      if (socket.destroyed || redeemed.voiceGrantExpiresAt <= Date.now()) return;
      wss.handleUpgrade(req, socket, head, (client) => {
        clearTimeout(deadline);
        handshakes.inc({ outcome: "ok" });
        attachVoiceClient({ deps, client, redeemed, engines, capabilities, nativeVoiceEnabled: useNativeVoice, useOpenAiVoice, legacyAvailable: status.configured, openAiConfigured: status.nativeOpenAi === true, vad, active, log, revokeGrant, releaseAdmission, migration });
        attached = true;
      });
    } finally {
      if (!attached) { releaseAdmission(); clearTimeout(deadline); await revokeGrant(); }
    }
  };
}

interface VoiceClientContext {
  deps: VoiceWsRouteDeps;
  client: WebSocket;
  redeemed: RedeemedVoiceTicket;
  engines: { stt: string; tts: string };
  capabilities: TalkCapabilities;
  nativeVoiceEnabled: boolean;
  useOpenAiVoice: boolean;
  legacyAvailable: boolean;
  openAiConfigured: boolean;
  vad: SpeechProbabilityModel | undefined;
  active: Gauge;
  log: NonNullable<VoiceWsRouteDeps['log']>;
  revokeGrant: () => Promise<void>;
  releaseAdmission?: () => void;
  migration: { end: () => void };
}

async function settleVoiceArchive(
  session: VoiceClientSession,
  { deps, redeemed, revokeGrant }: Pick<VoiceClientContext, 'deps' | 'redeemed' | 'revokeGrant'>,
  log: VoiceClientContext['log'],
): Promise<void> {
  try {
    if (session instanceof NativeTalkSession && session.boundNativeSessionId) {
      await session.finalize();
      const archive = session.archive;
      if (archive.entries.length) {
        const post = await (deps.archiveCall ?? archiveVoiceCall)({ voiceGrant: redeemed.voiceGrant, sessionId: session.boundNativeSessionId, ...archive, ...grantOptions(deps) });
        if (post.channelId !== redeemed.voiceConversation.channelId || post.threadRootPostId !== redeemed.voiceConversation.threadRootPostId) throw new Error('Voice archive returned a different conversation');
        log('voice archive posted', { postId: post.postId });
      }
    }
  } catch (error) {
    log('voice archive failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await revokeGrant();
  }
}

function sendVoiceEvent(client: WebSocket, event: TalkServerEvent): void {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
}

function closeVoiceSession(session: VoiceClientSession): void {
  if (session instanceof NativeTalkSession) void session.finalize();
  else session?.close();
}

function endVoiceForMigration(send: (event: TalkServerEvent) => void, teardown: (reason: string) => void): void {
  send({ type: 'error', code: 'internal', message: 'Your workspace is moving. Reconnect voice when the move finishes.', recoverable: false });
  teardown('workspace-moving');
}

function attachVoiceClient({ deps, client, redeemed, engines, capabilities, nativeVoiceEnabled, useOpenAiVoice, legacyAvailable, openAiConfigured, vad, active, log, revokeGrant, releaseAdmission, migration }: VoiceClientContext): void {
  active.inc();
  const events = deps.eventSourceForAgent(redeemed.expectedAgentId);
  const relay = deps.createRelayClient?.(redeemed.gatewayId)
    ?? createVoiceRelayClient({ baseUrl: deps.relayBaseUrl, gatewayId: redeemed.gatewayId, fetchImpl: deps.fetchImpl });
  const send = (event: TalkServerEvent) => sendVoiceEvent(client, event);
  const sessionLog = (message: string, fields?: Record<string, unknown>) =>
    log(message, { uid: redeemed.uid, gatewayId: redeemed.gatewayId, ...Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => [key, typeof value === "string" ? value.replaceAll(redeemed.voiceGrant, "[redacted]") : value])) });
  let conversation: VoiceConversation | null = null;
  let bindingStarted = false;
  let admitted = false;
  let checkingConversation = false;
  const resolveConversation = deps.resolveConversation ?? resolveVoiceConversation;
  const reauthorize = async () => {
    if (!conversation) throw new Error("Voice conversation is not bound");
    const sessionId = session instanceof NativeTalkSession ? session.boundNativeSessionId : session?.sessionId;
    const current = sessionId
      ? await (deps.bindGrant ?? bindVoiceGrant)({ voiceGrant: redeemed.voiceGrant, sessionId, ...grantOptions(deps) })
      : await resolveConversation({ uid: redeemed.uid, gatewayId: redeemed.gatewayId, channelId: redeemed.voiceConversation.channelId, threadRootPostId: redeemed.voiceConversation.threadRootPostId, expectedAgentId: redeemed.expectedAgentId });
    assertConversationScope(current, redeemed);
    if (sessionId) assertGrantBinding(current as VoiceGrantBinding, redeemed, sessionId);
    if (current.sessionKey !== conversation.sessionKey || current.agentId !== conversation.agentId || current.callerMmUserId !== conversation.callerMmUserId) throw new Error("Voice conversation changed");
    if (nativeVoiceEnabled && !current.nativeInterrupt) throw new Error("Native voice control is no longer authorized");
    return current;
  };
  const sessionCapabilities = { ...capabilities, interrupt: false };
  let session: VoiceClientSession = null;
  const createLegacySession = (sessionId?: string) => new TalkSession({
    ...(sessionId ? { sessionId } : {}),
    send,
    sendAudio: (pcm) => {
      if (client.readyState === WebSocket.OPEN) client.send(pcm, { binary: true });
    },
    relay,
    createBrain: () => {
      if (!conversation) throw new Error("Voice conversation is not bound");
      return createMattermostBrain({
        posts: { createPost: async (input) => {
          const current = await reauthorize();
          if (!session || input.channelId !== current.channelId) throw new Error("Voice turn is outside its bound conversation");
          const post = await (deps.postTurn ?? postVoiceTurn)({ voiceGrant: redeemed.voiceGrant, sessionId: session.sessionId, text: input.text, turnId: input.turnId, ...grantOptions(deps) });
          if (post.channelId !== current.channelId || post.threadRootPostId !== current.threadRootPostId || post.userId !== current.callerMmUserId) throw new Error("Voice post does not match its authorized sender or thread");
          return { id: post.postId };
        } },
        events,
        expectedSessionKey: conversation.sessionKey,
        ...(conversation.nativeInterrupt ? { interruptRun: async (target: { runId: string; sessionKey: string }) => {
          const current = await reauthorize();
          if (!current.nativeInterrupt || target.sessionKey !== current.sessionKey) throw new Error("Agent interruption is no longer available");
          return interruptNativeVoiceRun({ ...current, ...target });
        } } : {}),
        log: sessionLog,
      });
    },
    vad: vad!,
    engines,
    capabilities: sessionCapabilities,
    log: sessionLog,
  });
  log("voice ws session open", { uid: redeemed.uid, gatewayId: redeemed.gatewayId });

  let closed = false;
  const agentReadinessPollMs = Math.max(100, Math.floor(deps.agentReadinessPollMs ?? 1_000));
  let conversationTimer: ReturnType<typeof setInterval> | null = null;
  let agentReadinessTimer: ReturnType<typeof setInterval> | null = null;
  const teardown = (reason: string) => {
    if (closed) return;
    closed = true;
    if (agentReadinessTimer) clearInterval(agentReadinessTimer);
    if (conversationTimer) clearInterval(conversationTimer);
    clearTimeout(expiryTimer);
    active.dec();
    closeVoiceSession(session);
    try {
      client.close(1000, reason);
    } catch {
      /* already closed */
    }
    void settleVoiceArchive(session, { deps, redeemed, revokeGrant }, sessionLog).finally(() => releaseAdmission?.());
    log("voice ws session closed", { uid: redeemed.uid, sessionId: session?.sessionId, reason });
  };
  migration.end = () => endVoiceForMigration(send, teardown);
  const expiryTimer = setTimeout(() => {
    send({ type: "error", code: "internal", message: "This voice session expired. Start voice again.", recoverable: false });
    teardown("grant-expired");
  }, Math.max(0, redeemed.voiceGrantExpiresAt - Date.now() - (nativeVoiceEnabled ? VOICE_ARCHIVE_HEADROOM_MS : 0)));
  expiryTimer.unref?.();
  agentReadinessTimer = setInterval(() => {
    if (deps.isAgentReady(redeemed.expectedAgentId)) return;
    send({ type: "error", code: "internal", message: VOICE_AGENT_UNAVAILABLE_MESSAGE, recoverable: false });
    teardown("agent-unavailable");
  }, agentReadinessPollMs);
  agentReadinessTimer.unref?.();

  conversationTimer = setInterval(() => {
    if (!conversation || !admitted || checkingConversation || closed) return;
    checkingConversation = true;
    void reauthorize().catch((error) => {
      sessionLog("voice conversation revoked", { error: String(error) });
      send({ type: "error", code: "internal", message: "This voice conversation is no longer available. Reconnect from your current conversation.", recoverable: false });
      teardown("conversation-revoked");
    }).finally(() => { checkingConversation = false; });
  }, deps.conversationCheckMs ?? 10_000);
  conversationTimer.unref?.();

  let startupRaw = '';
  const fallbackToOriginal = (sessionId: string, reason: string) => {
    session = null;
    admitted = false;
    sessionLog('OpenAI voice startup failed; using original voice', { reason });
    void (async () => {
      vad = await deps.createVad();
      if (closed) return;
      await reauthorize();
      if (closed) return;
      const original = createLegacySession(sessionId);
      const bound = await (deps.bindGrant ?? bindVoiceGrant)({ voiceGrant: redeemed.voiceGrant, sessionId, ...grantOptions(deps) });
      assertGrantBinding(bound, redeemed, sessionId);
      if (closed) { original.close(); return; }
      session = original;
      admitted = true;
      const start = parseTalkClientMessage(startupRaw);
      if (start?.type !== 'session.start') throw new Error('Voice fallback startup is unavailable');
      await original.handleText(JSON.stringify({ ...start, settings: { ...start.settings, voice: '' } }));
    })().catch(error => {
      sessionLog('original voice fallback failed', { error: String(error) });
      send({ type: 'error', code: 'internal', message: VOICE_ENGINE_FAILED_MESSAGE, recoverable: false });
      teardown('fallback-failed');
    });
  };

  const bindConversation = async (channelId: string, threadRootPostId: string): Promise<boolean> => {
    bindingStarted = true;
    try {
      if (channelId !== redeemed.voiceConversation.channelId || threadRootPostId !== redeemed.voiceConversation.threadRootPostId) throw new Error("Voice ticket thread does not match session startup");
      const resolved = await resolveConversation({ uid: redeemed.uid, gatewayId: redeemed.gatewayId, channelId, threadRootPostId, expectedAgentId: redeemed.expectedAgentId });
      assertConversationScope(resolved, redeemed);
      if (closed) return false;
      conversation = resolved;
      sessionCapabilities.interrupt = resolved.nativeInterrupt;
      if (nativeVoiceEnabled) {
        if (!resolved.nativeInterrupt) throw new Error("Native voice requires current native conversation authority");
        session = (deps.createNativeSession ?? (options => new NativeTalkSession(options)))({ provider: useOpenAiVoice ? 'octogee-openai' : 'octogee', ...(useOpenAiVoice && legacyAvailable ? { onUnavailable: fallbackToOriginal } : {}), voiceGrant: redeemed.voiceGrant, voiceGrantExpiresAt: redeemed.voiceGrantExpiresAt, conversation: resolved, bindSession: async sessionId => {
          const bound = await (deps.bindGrant ?? bindVoiceGrant)({ voiceGrant: redeemed.voiceGrant, sessionId, ...grantOptions(deps) });
          assertGrantBinding(bound, redeemed, sessionId);
          if (!bound.nativeInterrupt || bound.callerMmUserId !== resolved.callerMmUserId) throw new Error('Native voice conversation changed');
          return bound;
        }, onClose: () => teardown('native-session-closed'), send, sendAudio: pcm => { if (client.readyState === WebSocket.OPEN) client.send(pcm, { binary: true }); }, reauthorize, log: sessionLog });
      } else {
        session = createLegacySession();
        const bound = await (deps.bindGrant ?? bindVoiceGrant)({ voiceGrant: redeemed.voiceGrant, sessionId: session.sessionId, ...grantOptions(deps) });
        if (closed) return false;
        assertGrantBinding(bound, redeemed, session.sessionId);
        conversation = bound;
      }
      admitted = true;
      return true;
    } catch (error) {
      sessionLog("voice conversation refused", { error: String(error) });
      send({ type: "error", code: "internal", message: "This voice conversation is not available. Reconnect from your current conversation.", recoverable: false });
      teardown("conversation-refused");
      return false;
    }
  };

  const onAudioFrame = (buf: Buffer) => {
    if (buf.length > MAX_CLIENT_AUDIO_FRAME_BYTES) {
      send({ type: "error", code: "bad_message", message: "audio frame too large", recoverable: false });
      teardown("frame-too-large");
      return;
    }
    if (admitted) session?.handleAudio(buf);
  };

  const onFrame = async (data: WebSocket.RawData, isBinary: boolean) => {
    if (closed) return;
    const buf = rawDataToBuffer(data);
    if (isBinary) { onAudioFrame(buf); return; }
    if (buf.length > MAX_CLIENT_TEXT_FRAME_BYTES) {
      send({ type: "error", code: "bad_message", message: "message too large", recoverable: false });
      teardown("message-too-large");
      return;
    }
    const raw = buf.toString("utf8");
    const message = parseTalkClientMessage(raw);
    if (message?.type === "session.start" && !bindingStarted) {
      startupRaw = raw;
      if (!await bindConversation(message.channelId, message.threadRootPostId)) return;
    } else if (!admitted) {
      if (message?.type === "session.end") teardown("session-ended");
      else send({ type: "error", code: "session_not_started", message: "Voice is still connecting.", recoverable: true });
      return;
    }
    const frame = originalVoiceFrame(raw, message, session, openAiConfigured);
    await session?.handleText(frame);
    if (session?.currentState === "closed") teardown("session-ended");
  };
  client.on("message", (data, isBinary) => {
    void onFrame(data, isBinary).catch((err) => {
      sessionLog("voice ws session failed", { sessionId: session?.sessionId, error: err instanceof Error ? err.stack ?? err.message : String(err) });
      send({ type: "error", code: "internal", message: "the voice engine hit an error; please reconnect", recoverable: false });
      teardown("session-error");
    });
  });
  client.on("close", () => teardown("client-closed"));
  client.on("error", () => teardown("client-error"));
}
