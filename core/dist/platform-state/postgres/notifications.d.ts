import type { PostgresContext } from "./session.js";
export declare const CHANGE_CHANNEL = "platform_state";
export interface NotificationTiming {
    readonly initialReconnectDelayMs: number;
    readonly maxReconnectDelayMs: number;
}
export declare class ChangeNotifications {
    private readonly context;
    private readonly timing;
    private client;
    private connecting;
    private reconnectTimer;
    private reconnectDelayMs;
    private closed;
    private readonly released;
    private readonly listeners;
    constructor(context: PostgresContext, timing: NotificationTiming);
    subscribe(aggregate: string, wake: () => void): () => void;
    close(): Promise<void>;
    private ensureConnected;
    private release;
    private connect;
    private onNotification;
    private wakeAll;
    private drop;
    private scheduleReconnect;
    private disconnect;
}
