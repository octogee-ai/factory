export const CHANGE_CHANNEL = "platform_state";
export class ChangeNotifications {
    context;
    timing;
    client = null;
    connecting = null;
    reconnectTimer = null;
    reconnectDelayMs;
    closed = false;
    released = new WeakSet();
    listeners = new Map();
    constructor(context, timing) {
        this.context = context;
        this.timing = timing;
        this.reconnectDelayMs = timing.initialReconnectDelayMs;
    }
    subscribe(aggregate, wake) {
        const wakes = this.listeners.get(aggregate) ?? new Set();
        wakes.add(wake);
        this.listeners.set(aggregate, wakes);
        this.ensureConnected();
        return () => {
            wakes.delete(wake);
            if (wakes.size === 0)
                this.listeners.delete(aggregate);
            if (this.listeners.size === 0)
                this.disconnect();
        };
    }
    async close() {
        this.closed = true;
        this.listeners.clear();
        await this.connecting;
        this.disconnect();
    }
    ensureConnected() {
        if (this.closed || this.client !== null || this.connecting !== null || this.reconnectTimer !== null)
            return;
        this.connecting = this.connect().finally(() => {
            this.connecting = null;
        });
    }
    release(client, reason) {
        if (this.released.has(client))
            return;
        this.released.add(client);
        client.release(reason);
    }
    async connect() {
        let client;
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
        }
        catch (error) {
            if (client !== undefined)
                this.release(client, error instanceof Error ? error : true);
            this.context.logger.warn("platform state change notifications unavailable; watchers poll until they return", { error });
            this.scheduleReconnect();
        }
    }
    onNotification(message) {
        if (message.channel !== CHANGE_CHANNEL)
            return;
        const wakes = message.payload === undefined ? undefined : this.listeners.get(message.payload);
        for (const wake of wakes ?? [])
            wake();
    }
    wakeAll() {
        for (const wakes of this.listeners.values())
            for (const wake of wakes)
                wake();
    }
    drop(client, error) {
        if (this.client !== client)
            return;
        this.client = null;
        this.release(client, error);
        this.context.logger.warn("platform state change notification connection lost; watchers poll until it returns", { error });
        this.wakeAll();
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.closed || this.listeners.size === 0 || this.reconnectTimer !== null)
            return;
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(delay * 2, this.timing.maxReconnectDelayMs);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.ensureConnected();
        }, delay);
    }
    disconnect() {
        if (this.reconnectTimer !== null)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const client = this.client;
        this.client = null;
        if (client !== null)
            this.release(client, true);
    }
}
