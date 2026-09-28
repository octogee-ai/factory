import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { parseTalkClientMessage, resolveTalkSettings, TALK_PROTOCOL_VERSION, TALK_OUTPUT_SAMPLE_RATE, type ResolvedTalkSettings, type TalkClientMessage, type TalkServerEvent } from '@octogee/shared/types/voice';
import { openNativeUserSocket, type NativeUserSocket } from '../openclaw-control/native-user-client.js';
import { attachUpstreamRpcClient, type UpstreamRpcClient } from '../chat-proxy/openclaw/bridge-upstream-rpc.js';

interface NativeTalkOptions {
  conversation: { uid: string; gatewayId: string; agentId: string; sessionKey: string };
  send: (event: TalkServerEvent) => void;
  sendAudio: (audio: Buffer) => void;
  reauthorize: () => Promise<unknown>;
  log: (message: string, fields?: Record<string, unknown>) => void;
  open?: typeof openNativeUserSocket;
  attachRpc?: typeof attachUpstreamRpcClient;
}

export class NativeTalkSession {
  sessionId = randomUUID();
  currentState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'closed' = 'idle';
  private connection: NativeUserSocket | undefined;
  private started = false;
  private rpc: UpstreamRpcClient | undefined;
  private nativeId: string | undefined;
  private settings: ResolvedTalkSettings = resolveTalkSettings();
  private listening = false;
  private outputTurn = '';
  private reply = '';
  private audioStarted = false;
  private replayChunks: Buffer[] = [];
  private replayBytes = 0;
  private readonly marks = new Set<string>();
  private audioInFlight = 0;
  private readonly earlyEvents: Record<string, unknown>[] = [];
  constructor(private readonly options: NativeTalkOptions) {}

  private isClosed(): boolean { return this.currentState === 'closed'; }
  private async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.rpc) throw new Error('Native voice is not connected');
    const response = await this.rpc.call<T>(method, params);
    if (!response.ok) throw new Error(response.reason);
    return response.result;
  }
  private state(state: Exclude<NativeTalkSession['currentState'], 'closed'>): void {
    this.currentState = state;
    this.options.send({ type: 'state', state, ...(this.outputTurn ? { turnId: this.outputTurn } : {}) });
  }
  private fail(error: unknown): void {
    this.options.log('native voice transport failed', { error: String(error) });
    this.options.send({ type: 'error', code: 'internal', message: error instanceof Error ? error.message : 'Native voice transport failed', recoverable: false });
    this.close();
  }
  private readonly onMessage = (data: WebSocket.RawData) => {
    let frame: { type?: string; event?: string; payload?: Record<string, unknown> };
    try { frame = JSON.parse(data.toString()); } catch { this.fail(new Error('Native voice sent a malformed frame')); return; }
    if (frame.type !== 'event' || !frame.payload || this.currentState === 'closed') return;
    if (frame.event === 'ui.command') { this.forwardUiCommand(frame.payload); return; }
    if (frame.event !== 'talk.event') return;
    if (!this.nativeId) {
      if (this.earlyEvents.length >= 100) { this.fail(new Error('Native voice startup event limit exceeded')); return; }
      this.earlyEvents.push(frame.payload); return;
    }
    this.handleNativeEvent(frame.payload);
  };
  private forwardUiCommand(payload: Record<string, unknown>): void {
    const target = this.options.conversation;
    const command = payload.command;
    const commandSessionKey = typeof command === 'object' && command !== null ? (command as { sessionKey?: unknown }).sessionKey : undefined;
    const boundScope = (payload.agentId === undefined || payload.agentId === target.agentId) &&
      (payload.sessionKey === undefined || payload.sessionKey === target.sessionKey) &&
      (commandSessionKey === undefined || commandSessionKey === target.sessionKey);
    if (typeof command !== 'object' || command === null || !boundScope) {
      this.options.log('native voice UI command rejected outside bound conversation');
      return;
    }
    this.options.send({ type: 'ui.command', payload });
  }
  private receiveTranscript(event: Record<string, unknown>): void {
    if (typeof event.text !== 'string') return;
    if (event.role === 'user') {
      this.options.send({ type: event.final ? 'transcript.final' : 'transcript.delta', turnId: this.outputTurn, text: event.text, ...(event.final ? { reason: 'endpoint' as const } : {}) } as TalkServerEvent);
      if (event.final) this.state('thinking');
    } else if (event.role === 'assistant') {
      this.reply = event.textMode === 'snapshot' ? event.text : this.reply + event.text;
      this.options.send({ type: 'reply.final', turnId: this.outputTurn, text: this.reply });
    }
  }
  private receiveAudio(event: Record<string, unknown>): void {
    if (typeof event.audioBase64 !== 'string') return;
    if (!this.audioStarted) {
      this.audioStarted = true;
      this.state('speaking');
      this.options.send({ type: 'audio.start', turnId: this.outputTurn, sampleRate: TALK_OUTPUT_SAMPLE_RATE });
    }
    const audio = Buffer.from(event.audioBase64, 'base64');
    if (this.replayBytes + audio.length <= 16 * 1024 * 1024) { this.replayChunks.push(audio); this.replayBytes += audio.length; }
    else { this.replayChunks = []; this.replayBytes = 16 * 1024 * 1024 + 1; }
    this.options.sendAudio(audio);
  }
  private selectOutputTurn(event: Record<string, unknown>): void {
    const talk = event.talkEvent as { turnId?: string } | undefined;
    if (talk?.turnId && talk.turnId !== this.outputTurn) {
      this.outputTurn = talk.turnId; this.audioStarted = false; this.reply = ''; this.replayChunks = []; this.replayBytes = 0;
    }
    this.outputTurn ||= this.nativeId!;
  }
  private handleNativeEvent(event: Record<string, unknown>): void {
    if (event.relaySessionId !== this.nativeId) return;
    this.selectOutputTurn(event);
    switch (event.type) {
      case 'ready':
        this.options.send({ type: 'session.ready', sessionId: this.sessionId, protocol: TALK_PROTOCOL_VERSION, input: { sampleRate: 24000 }, output: { sampleRate: TALK_OUTPUT_SAMPLE_RATE }, engines: { stt: 'native', tts: 'native' }, capabilities: { speed: false, interrupt: true, bargeIn: true }, settings: this.settings });
        break;
      case 'responseStarted': this.state('thinking'); break;
      case 'transcript': this.receiveTranscript(event); break;
      case 'audio': this.receiveAudio(event); break;
      case 'audioDone': this.options.send({ type: 'audio.end', turnId: this.outputTurn, cancelled: false }); break;
      case 'clear':
        this.marks.clear(); this.audioStarted = false;
        this.options.send({ type: 'audio.end', turnId: this.outputTurn, cancelled: true });
        this.state(this.listening ? 'listening' : 'idle'); break;
      case 'mark':
        if (typeof event.markName !== 'string') return;
        this.marks.add(event.markName); this.options.send({ type: 'audio.mark', name: event.markName }); break;
      case 'error': this.fail(new Error(String(event.message ?? 'Native voice failed'))); break;
      case 'close': this.fail(new Error('Native voice session ended')); break;
    }
  }
  private async startSession(message: Extract<TalkClientMessage, { type: 'session.start' }>): Promise<void> {
    if (this.started) throw new Error('Voice session already started');
    this.started = true;
    if (message.mode !== 'converse') throw new Error('Native Talk requires conversation mode');
    this.settings = { ...resolveTalkSettings(message.settings), endpointing: 'normal' };
    await this.options.reauthorize();
    const connection = await (this.options.open ?? openNativeUserSocket)(this.options.conversation.uid, this.options.conversation.gatewayId, process.env, { caps: ['ui-commands'] });
    if (this.isClosed()) { connection.ws.close(); return; }
    this.connection = connection;
    this.rpc = (this.options.attachRpc ?? attachUpstreamRpcClient)(connection.ws, { timeoutMs: 15000 });
    connection.ws.on('message', this.onMessage);
    connection.ws.on('close', () => { if (this.currentState !== 'closed') this.fail(new Error('Native voice connection closed')); });
    connection.ws.on('error', (error) => this.fail(error));
    const created = await this.call<{ sessionId: string; relaySessionId: string }>('talk.session.create', { sessionKey: this.options.conversation.sessionKey, mode: 'realtime', transport: 'gateway-relay', brain: 'agent-consult', provider: 'octogee', ...(this.settings.voice ? { voice: this.settings.voice } : {}), silenceDurationMs: 700 });
    if (typeof created.sessionId !== 'string' || created.sessionId !== created.relaySessionId) throw new Error('Native voice returned an invalid session');
    this.nativeId = created.sessionId;
    for (const event of this.earlyEvents.splice(0)) this.handleNativeEvent(event);
  }
  private async interruptAgent(requestId: string): Promise<void> {
    const wasAwaitingRun = this.currentState === 'thinking';
    this.options.send({ type: 'agent.interrupting', requestId });
    try {
      await this.options.reauthorize();
      await this.call('talk.session.cancelOutput', { sessionId: this.nativeId, reason: 'speech-only' });
      const result = await this.call('talk.session.steer', { sessionId: this.nativeId, sessionKey: this.options.conversation.sessionKey, text: 'Stop', mode: 'cancel' });
      if (result.reason === 'no_active_run' && wasAwaitingRun) throw new Error('The native agent has not confirmed an active run yet. Try interrupting again.');
      if (result.sessionKey !== this.options.conversation.sessionKey || (!result.aborted && result.reason !== 'no_active_run')) throw new Error(typeof result.message === 'string' ? result.message : 'Native agent did not confirm interruption');
      this.options.send({ type: 'agent.interrupted', requestId, status: result.aborted ? 'aborted' : 'no-active-run' });
    } catch (error) { this.options.send({ type: 'agent.interrupted', requestId, status: 'failed', message: error instanceof Error ? error.message : String(error) }); }
  }
  private updateSettings(settings: Extract<TalkClientMessage, { type: 'settings.update' }>['settings']): void {
    const next = resolveTalkSettings(this.settings, settings);
    if (next.voice !== this.settings.voice || next.endpointing !== this.settings.endpointing) {
      this.options.send({ type: 'error', code: 'internal', message: 'End voice and reconnect to apply the new voice or listening pace.', recoverable: true });
    }
    this.settings = { ...next, voice: this.settings.voice, endpointing: this.settings.endpointing };
    this.options.send({ type: 'settings', settings: this.settings });
  }
  private replay(): void {
    if (this.replayChunks.length) {
      this.state('speaking');
      this.options.send({ type: 'audio.start', turnId: this.outputTurn, sampleRate: TALK_OUTPUT_SAMPLE_RATE });
      for (const audio of this.replayChunks) { this.options.sendAudio(audio); }
      this.options.send({ type: 'audio.end', turnId: this.outputTurn, cancelled: false });
    } else this.options.send({ type: 'error', code: 'internal', message: 'There is no complete recent audio to replay.', recoverable: true });
  }
  private async handleControl(message: TalkClientMessage): Promise<void> {
    switch (message.type) {
      case 'listen.start': this.listening = true; this.state('listening'); break;
      case 'listen.stop': this.listening = false; this.state('idle'); break;
      case 'turn.commit': this.listening = false; this.state('idle'); break;
      case 'speak.cancel': await this.call('talk.session.cancelOutput', { sessionId: this.nativeId, reason: 'speech-only' }); break;
      case 'agent.interrupt': await this.interruptAgent(message.requestId); break;
      case 'playback.mark':
        if (this.marks.delete(message.name)) await this.call('talk.session.acknowledgeMark', { sessionId: this.nativeId, markName: message.name });
        break;
      case 'playback.done': this.audioStarted = false; this.state(this.listening ? 'listening' : 'idle'); break;
      case 'settings.update': this.updateSettings(message.settings); break;
      case 'replay': this.replay(); break;
    }
  }
  async handleText(raw: string): Promise<void> {
    const message = parseTalkClientMessage(raw);
    if (!message) throw new Error('Invalid voice message');
    if (this.currentState === 'closed') return;
    if (message.type === 'session.end') { this.close(); return; }
    if (message.type === 'session.start') { await this.startSession(message); return; }
    if (!this.nativeId) throw new Error('Native voice is still connecting');
    await this.handleControl(message);
  }
  handleAudio(audio: Buffer): void {
    if (!this.nativeId || !this.listening || this.currentState === 'closed') return;
    if (++this.audioInFlight > 64) { this.fail(new Error('Native voice audio connection is too slow')); return; }
    void this.call('talk.session.appendAudio', { sessionId: this.nativeId, audioBase64: audio.toString('base64') }).catch(error => this.fail(error)).finally(() => { this.audioInFlight--; });
  }
  close(): void {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed'; this.marks.clear();
    this.rpc?.dispose(); this.connection?.ws.off('message', this.onMessage); this.connection?.ws.close();
  }
}
