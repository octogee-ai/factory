import type { VoiceRunInterruption } from "./native-control.js";

export interface BrainAgentEvent {
  kind: "agent";
  runId: string;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
}

/** OpenClaw's `diagnostic` `message.received`: the inbound Mattermost post id and the session it was routed to. */
export interface BrainInboundEvent {
  kind: "inbound";
  messageId: string;
  sessionKey: string;
  ts: number;
}

export type BrainEvent = BrainAgentEvent | BrainInboundEvent;

export interface AgentEventSource {
  subscribe(listener: (event: BrainEvent) => void): () => void;
}

export interface BrainPostClient {
  createPost(input: {
    channelId: string;
    text: string;
    turnId: string;
  }): Promise<{ id: string }>;
}

export type BrainReplyStatus = "complete" | "aborted" | "error" | "timeout";

export interface BrainReplyHandlers {
  onRunStarted?: (runId: string) => void;
  onDelta: (text: string) => void;
  onDone: (result: { text: string; status: BrainReplyStatus; runId: string | null }) => void;
}

export interface BrainTurnHandle {
  postId: string;
  cancel(): void;
  interrupt(): Promise<VoiceRunInterruption>;
}

export interface MattermostBrainOptions {
  posts: BrainPostClient;
  events: AgentEventSource;
  expectedSessionKey?: string;
  interruptRun?: (target: { runId: string; sessionKey: string }) => Promise<VoiceRunInterruption>;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  /** How long to wait for the Agent to pick the post up and start answering before giving up. */
  replyStartTimeoutMs?: number;
  /** How long a run may stream before the reply is closed with what arrived. */
  replyMaxMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export const BRAIN_REPLY_START_TIMEOUT_MS = 25_000;
export const BRAIN_REPLY_MAX_MS = 180_000;
export const BRAIN_PENDING_EVENT_CAP = 512;
const LIFECYCLE_END_STATUS: Record<string, BrainReplyStatus | undefined> = {
  end: "complete",
  abort: "aborted",
  error: "error",
};

function lifecyclePhase(event: BrainAgentEvent): string | null {
  return event.stream === "lifecycle" && typeof event.data.phase === "string" ? event.data.phase : null;
}

/** New assistant text from a delta, or from a cumulative snapshot that extends what we have. */
function assistantPiece(data: Record<string, unknown>, seenText: string): string {
  if (typeof data.delta === "string" && data.delta) return data.delta;
  const cumulative = typeof data.text === "string" ? data.text : "";
  if (cumulative.length > seenText.length && cumulative.startsWith(seenText)) return cumulative.slice(seenText.length);
  return "";
}

interface ActiveRun {
  runId: string;
  text: string;
}

/**
 * What the Agent is doing right now on each session, folded from the event
 * stream for the life of the Talk session: the run that is active (started, not
 * ended) and how much assistant text it has produced. A voice post that lands
 * while a run is active is steered into that run by OpenClaw's default queue
 * mode, so the reply arrives on the active run rather than a fresh one.
 */
class SessionLedger {
  private readonly active = new Map<string, ActiveRun>();

  observe(event: BrainAgentEvent): void {
    if (!event.sessionKey) return;
    const phase = lifecyclePhase(event);
    if (phase === "start") {
      this.active.set(event.sessionKey, { runId: event.runId, text: "" });
      return;
    }
    const current = this.active.get(event.sessionKey);
    if (!current || current.runId !== event.runId) return;
    if (phase && LIFECYCLE_END_STATUS[phase]) {
      this.active.delete(event.sessionKey);
      return;
    }
    if (event.stream === "assistant") current.text += assistantPiece(event.data, current.text);
  }

  snapshot(sessionKey: string): ActiveRun | null {
    const run = this.active.get(sessionKey);
    return run ? { ...run } : null;
  }
}

type Phase =
  | { name: "await-inbound" }
  | { name: "await-start"; sessionKey: string }
  | { name: "adopted"; runId: string; sessionKey: string; steered: boolean };

interface Observation {
  event: BrainEvent;
  /** For inbound events: the run active on that session at the moment the post was received. */
  activeAtInbound: ActiveRun | null;
}

/**
 * The Agent behind a Talk session is the Builder's coach reached the same way
 * typing reaches it: a Mattermost post in the conversation channel. The reply is
 * read back live from the OpenClaw event stream, correlated exactly: OpenClaw
 * reports which post it received (`message.received` carries the post id and the
 * session), and the run that starts on that session after our post is ours. If a
 * run is already active on that session, the post is steered into it and its
 * assistant text from that point on is the reply. Nothing is spoken on a guess.
 */
export function createMattermostBrain(options: MattermostBrainOptions) {
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const replyStartTimeoutMs = options.replyStartTimeoutMs ?? BRAIN_REPLY_START_TIMEOUT_MS;
  const replyMaxMs = options.replyMaxMs ?? BRAIN_REPLY_MAX_MS;
  const log = options.log ?? (() => undefined);
  const ledger = new SessionLedger();
  const unsubscribeLedger = options.events.subscribe((event) => {
    if (event.kind === "agent") ledger.observe(event);
  });
  const inFlight = new Set<(status: BrainReplyStatus) => void>();

  return {
    async ask(
      input: { channelId: string; text: string; turnId: string },
      handlers: BrainReplyHandlers,
    ): Promise<BrainTurnHandle> {
      let phase: Phase = { name: "await-inbound" };
      let postId: string | null = null;
      let runText = "";
      let replyText = "";
      let done = false;
      let unsubscribe: (() => void) | null = null;
      let startTimer: ReturnType<typeof setTimeout> | null = null;
      let maxTimer: ReturnType<typeof setTimeout> | null = null;
      const pending: Observation[] = [];

      const finish = (status: BrainReplyStatus) => {
        if (done) return;
        done = true;
        inFlight.delete(finish);
        if (startTimer) clearTimer(startTimer);
        if (maxTimer) clearTimer(maxTimer);
        unsubscribe?.();
        handlers.onDone({ text: replyText, status, runId: phase.name === "adopted" ? phase.runId : null });
      };
      const cancel = () => finish("aborted");
      const interrupt = async (): Promise<VoiceRunInterruption> => {
        if (!options.interruptRun) throw new Error("Agent interruption is not available on this gateway.");
        if (phase.name !== "adopted") throw new Error("The agent run is not identified yet. Try interrupting again.");
        const result = await options.interruptRun({ runId: phase.runId, sessionKey: phase.sessionKey });
        finish("aborted");
        return result;
      };

      const adopt = (run: ActiveRun, sessionKey: string, steered: boolean) => {
        phase = { name: "adopted", runId: run.runId, sessionKey, steered };
        runText = run.text;
        replyText = "";
        if (!steered && startTimer) {
          clearTimer(startTimer);
          startTimer = null;
        }
        maxTimer ??= setTimer(() => finish("timeout"), replyMaxMs);
        handlers.onRunStarted?.(run.runId);
      };

      const onInbound = ({ event, activeAtInbound }: Observation & { event: BrainInboundEvent }) => {
        if (phase.name !== "await-inbound" || event.messageId !== postId) return;
        if (options.expectedSessionKey && event.sessionKey !== options.expectedSessionKey) {
          log("voice inbound session mismatch", { expectedSessionKey: options.expectedSessionKey, sessionKey: event.sessionKey });
          finish("error");
          return;
        }
        if (activeAtInbound) adopt(activeAtInbound, event.sessionKey, true);
        else phase = { name: "await-start", sessionKey: event.sessionKey };
      };

      const onAdoptedAgentEvent = (event: BrainAgentEvent, current: Extract<Phase, { name: "adopted" }>) => {
        if (event.stream === "assistant") {
          const piece = assistantPiece(event.data, runText);
          if (!piece) return;
          runText += piece;
          replyText += piece;
          if (startTimer) {
            clearTimer(startTimer);
            startTimer = null;
          }
          handlers.onDelta(piece);
          return;
        }
        const status = LIFECYCLE_END_STATUS[lifecyclePhase(event) ?? ""];
        if (!status) return;
        if (current.steered && status === "complete" && !replyText) {
          phase = { name: "await-start", sessionKey: current.sessionKey };
          return;
        }
        finish(status);
      };

      const onAgent = (event: BrainAgentEvent) => {
        if (phase.name === "await-start") {
          if (event.sessionKey === phase.sessionKey && lifecyclePhase(event) === "start") {
            adopt({ runId: event.runId, text: "" }, event.sessionKey, false);
          }
          return;
        }
        if (phase.name === "adopted" && event.runId === phase.runId) onAdoptedAgentEvent(event, phase);
      };

      const handle = (observation: Observation) => {
        if (observation.event.kind === "inbound") onInbound(observation as Observation & { event: BrainInboundEvent });
        else onAgent(observation.event);
      };

      unsubscribe = options.events.subscribe((event) => {
        if (done) return;
        const observation: Observation = {
          event,
          activeAtInbound: event.kind === "inbound" ? ledger.snapshot(event.sessionKey) : null,
        };
        if (postId === null) {
          if (pending.length >= BRAIN_PENDING_EVENT_CAP) pending.shift();
          pending.push(observation);
          return;
        }
        handle(observation);
      });
      inFlight.add(finish);

      let post: { id: string };
      try {
        post = await options.posts.createPost({ channelId: input.channelId, text: input.text, turnId: input.turnId });
      } catch (err) {
        done = true;
        inFlight.delete(finish);
        unsubscribe();
        throw err;
      }
      if (done) return { postId: post.id, cancel, interrupt };
      postId = post.id;
      startTimer = setTimer(() => {
        log("voice turn reply did not start", { postId, turnId: input.turnId, phase: phase.name });
        finish("timeout");
      }, replyStartTimeoutMs);
      for (const observation of pending.splice(0)) {
        if (done) break;
        handle(observation);
      }

      return { postId: post.id, cancel, interrupt };
    },

    /** Ends every in-flight turn and stops following the event stream. */
    dispose(): void {
      for (const finish of [...inFlight]) finish("aborted");
      unsubscribeLedger();
    },
  };
}

export type MattermostBrain = ReturnType<typeof createMattermostBrain>;
