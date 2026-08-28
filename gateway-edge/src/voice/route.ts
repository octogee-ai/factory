import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { Counter, Gauge, type Registry } from "prom-client";
import { internalFetch } from "@octogee/core/internal-fetch";
import { TALK_CAPABILITIES_DEFAULT, type TalkCapabilities, type TalkErrorCode, type TalkServerEvent } from "@octogee/shared/types/voice";
import { createActivityMmClientFactory } from "../chat-proxy/openclaw/mm-client.js";
import type { OpenClawRuntimeBroker } from "../chat-proxy/openclaw/runtime-broker.js";
import type { RollRosterUpgradeGate } from "../roll-roster.js";
import { createMattermostBrain, type AgentEventSource } from "./brain.js";
import { createVoiceRelayClient, type VoiceRelayClient } from "./relay-client.js";
import type { SpeechProbabilityModel } from "./silero-vad.js";
import { TalkSession } from "./talk-session.js";

export const VOICE_WS_PATH_RE = /\/api\/voice\/ws\/([a-f0-9-]{36})$/;
const MAX_CLIENT_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_CLIENT_TEXT_FRAME_BYTES = 16 * 1024;

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
  mmInternalUrl: string;
  createVad: () => Promise<SpeechProbabilityModel>;
  fetchImpl?: typeof fetch;
  createRelayClient?: (gatewayId: string) => VoiceRelayClient;
  registry?: Registry;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface RelayStatus {
  configured: boolean;
  engines?: { stt: string; tts: string };
  capabilities?: TalkCapabilities;
}

interface RedeemedVoiceTicket {
  uid: string;
  gatewayId: string;
  expectedAgentId: string;
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
      const verdict = deps.upgradeGate.checkUid(redeemed.uid);
      if (!verdict.allow) {
        handshakes.inc({ outcome: "fail:roster" });
        deps.upgradeGate.refuse(socket, verdict);
        return null;
      }
    }
    return redeemed;
  };

  const redeem = async (ticket: string, socket: Duplex): Promise<RedeemedVoiceTicket | null> => {
    try {
      const outcome = await deps.runtimeBroker.redeemOpenClawWs(ticket, "voice-ws");
      if (outcome.kind === "redeemed") return outcome.redeemed;
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
    if (!status.configured || !status.engines) {
      refuseWithError(req, socket, head, "fail:not-configured", { code: "not_configured", message: VOICE_NOT_CONFIGURED_MESSAGE });
      return;
    }
    const engines = status.engines;
    const capabilities = status.capabilities ?? TALK_CAPABILITIES_DEFAULT;

    let vad: SpeechProbabilityModel;
    try {
      vad = await deps.createVad();
    } catch (err) {
      log("voice ws vad load failed", { error: err instanceof Error ? err.message : String(err) });
      refuseWithError(req, socket, head, "fail:vad", { code: "internal", message: VOICE_ENGINE_FAILED_MESSAGE });
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      handshakes.inc({ outcome: "ok" });
      active.inc();
      const events = deps.eventSourceForAgent(redeemed.expectedAgentId);
      const relay = deps.createRelayClient?.(redeemed.gatewayId)
        ?? createVoiceRelayClient({ baseUrl: deps.relayBaseUrl, gatewayId: redeemed.gatewayId, fetchImpl: deps.fetchImpl });
      const mmClients = createActivityMmClientFactory({
        baseUrl: deps.mmInternalUrl,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      const send = (event: TalkServerEvent) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
      };
      const sessionLog = (message: string, fields?: Record<string, unknown>) =>
        log(message, { uid: redeemed.uid, gatewayId: redeemed.gatewayId, ...fields });
      const session = new TalkSession({
        send,
        sendAudio: (pcm) => {
          if (client.readyState === WebSocket.OPEN) client.send(pcm, { binary: true });
        },
        relay,
        createBrain: (mmToken) => createMattermostBrain({ posts: mmClients(mmToken), events, log: sessionLog }),
        vad,
        engines,
        capabilities,
        log: sessionLog,
      });
      log("voice ws session open", { uid: redeemed.uid, gatewayId: redeemed.gatewayId, sessionId: session.sessionId });

      let closed = false;
      const agentReadinessPollMs = Math.max(100, Math.floor(deps.agentReadinessPollMs ?? 1_000));
      let agentReadinessTimer: ReturnType<typeof setInterval> | null = null;
      const teardown = (reason: string) => {
        if (closed) return;
        closed = true;
        if (agentReadinessTimer) clearInterval(agentReadinessTimer);
        active.dec();
        session.close();
        try {
          client.close(1000, reason);
        } catch {
          /* already closed */
        }
        log("voice ws session closed", { uid: redeemed.uid, sessionId: session.sessionId, reason });
      };
      agentReadinessTimer = setInterval(() => {
        if (deps.isAgentReady(redeemed.expectedAgentId)) return;
        send({ type: "error", code: "internal", message: VOICE_AGENT_UNAVAILABLE_MESSAGE, recoverable: false });
        teardown("agent-unavailable");
      }, agentReadinessPollMs);
      agentReadinessTimer.unref?.();

      const onFrame = (data: WebSocket.RawData, isBinary: boolean) => {
        const buf = rawDataToBuffer(data);
        if (isBinary) {
          if (buf.length > MAX_CLIENT_AUDIO_FRAME_BYTES) {
            send({ type: "error", code: "bad_message", message: "audio frame too large", recoverable: false });
            teardown("frame-too-large");
            return;
          }
          session.handleAudio(buf);
          return;
        }
        if (buf.length > MAX_CLIENT_TEXT_FRAME_BYTES) {
          send({ type: "error", code: "bad_message", message: "message too large", recoverable: false });
          teardown("message-too-large");
          return;
        }
        session.handleText(buf.toString("utf8"));
        if (session.currentState === "closed") teardown("session-ended");
      };
      client.on("message", (data, isBinary) => {
        try {
          onFrame(data, isBinary);
        } catch (err) {
          log("voice ws session failed", { uid: redeemed.uid, sessionId: session.sessionId, error: err instanceof Error ? err.stack ?? err.message : String(err) });
          send({ type: "error", code: "internal", message: "the voice engine hit an error; please reconnect", recoverable: false });
          teardown("session-error");
        }
      });
      client.on("close", () => teardown("client-closed"));
      client.on("error", () => teardown("client-error"));
    });
  };
}
