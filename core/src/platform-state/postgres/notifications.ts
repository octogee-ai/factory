import type pg from "pg";
import type { PostgresContext } from "./session.js";

export const CHANGE_CHANNEL = "platform_state";

export interface NotificationTiming {
  readonly initialReconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
}

export class ChangeNotifications {
  private client: pg.PoolClient | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;
  private closed = false;
  private readonly released = new WeakSet<pg.PoolClient>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly context: PostgresContext,
    private readonly timing: NotificationTiming,
  ) {
    this.reconnectDelayMs = timing.initialReconnectDelayMs;
  }

  subscribe(aggregate: string, wake: () => void): () => void {
    const wakes = this.listeners.get(aggregate) ?? new Set<() => void>();
    wakes.add(wake);
    this.listeners.set(aggregate, wakes);
    this.ensureConnected();
    return () => {
      wakes.delete(wake);
      if (wakes.size === 0) this.listeners.delete(aggregate);
      if (this.listeners.size === 0) this.disconnect();
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.connecting;
    this.disconnect();
  }

  private ensureConnected(): void {
    if (this.closed || this.client !== null || this.connecting !== null || this.reconnectTimer !== null) return;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
  }

  private release(client: pg.PoolClient, reason: Error | true): void {
    if (this.released.has(client)) return;
    this.released.add(client);
    client.release(reason);
  }

  private async connect(): Promise<void> {
    let client: pg.PoolClient | undefined;
    try {
      client = await this.context.pool.connect();
      const connected = client;
      connected.on("notification", (message) => this.onNotification(message));
      connected.on("error", (error) => this.drop(connected, error));
      connected.on("end", () => this.drop(connected, new Error("change notification connection ended")));
      await connected.query(`LISTEN ${CHANGE_CHANNEL}`);
      if (this.closed || this.listeners.size === 0) {
        this.release(connected, true);
        return;
      }
      this.client = connected;
      this.reconnectDelayMs = this.timing.initialReconnectDelayMs;
      this.wakeAll();
    } catch (error) {
      if (client !== undefined) this.release(client, error instanceof Error ? error : true);
      this.context.logger.warn("platform state change notifications unavailable; watchers poll until they return", { error });
      this.scheduleReconnect();
    }
  }

  private onNotification(message: pg.Notification): void {
    if (message.channel !== CHANGE_CHANNEL) return;
    const wakes = message.payload === undefined ? undefined : this.listeners.get(message.payload);
    for (const wake of wakes ?? []) wake();
  }

  private wakeAll(): void {
    for (const wakes of this.listeners.values()) for (const wake of wakes) wake();
  }

  private drop(client: pg.PoolClient, error: Error): void {
    if (this.client !== client) return;
    this.client = null;
    this.release(client, error);
    this.context.logger.warn("platform state change notification connection lost; watchers poll until it returns", { error });
    this.wakeAll();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.listeners.size === 0 || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, this.timing.maxReconnectDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
  }

  private disconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (client !== null) this.release(client, true);
  }
}
