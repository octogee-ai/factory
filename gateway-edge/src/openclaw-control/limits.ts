export const OPENCLAW_CONTROL_MAX_SOCKETS = 2;
export const OPENCLAW_CONTROL_MAX_DESKTOP_STREAMS = 8;
export const OPENCLAW_CONTROL_MAX_IN_FLIGHT = 64;
export const OPENCLAW_CONTROL_MUTATION_LIMIT = 30;
export const OPENCLAW_CONTROL_MUTATION_WINDOW_MS = 60_000;

export interface OpenClawControlResourceIdentity {
  uid: string;
  gatewayId: string;
  sessionId: string;
}

interface Entry {
  sockets: number;
  desktopStreams: number;
  inFlight: number;
  mutationCount: number;
  mutationWindowStartedAt: number;
}

export interface OpenClawControlLease {
  release(): void;
}

export class OpenClawControlResourceLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxSockets: number;
  private readonly maxDesktopStreams: number;
  private readonly maxInFlight: number;
  private readonly mutationLimit: number;
  private readonly mutationWindowMs: number;
  private readonly now: () => number;

  constructor(options: {
    maxSockets?: number;
    maxDesktopStreams?: number;
    maxInFlight?: number;
    mutationLimit?: number;
    mutationWindowMs?: number;
    now?: () => number;
  } = {}) {
    this.maxSockets = options.maxSockets ?? OPENCLAW_CONTROL_MAX_SOCKETS;
    this.maxDesktopStreams = options.maxDesktopStreams ?? OPENCLAW_CONTROL_MAX_DESKTOP_STREAMS;
    this.maxInFlight = options.maxInFlight ?? OPENCLAW_CONTROL_MAX_IN_FLIGHT;
    this.mutationLimit = options.mutationLimit ?? OPENCLAW_CONTROL_MUTATION_LIMIT;
    this.mutationWindowMs = options.mutationWindowMs ?? OPENCLAW_CONTROL_MUTATION_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  acquireSocket(identity: OpenClawControlResourceIdentity): OpenClawControlLease | null {
    const key = this.key(identity);
    const entry = this.entry(key);
    if (entry.sockets >= this.maxSockets) return null;
    entry.sockets += 1;
    return this.lease(key, "sockets");
  }

  acquireRequest(identity: OpenClawControlResourceIdentity): OpenClawControlLease | null {
    const key = this.key(identity);
    const entry = this.entry(key);
    if (entry.inFlight >= this.maxInFlight) return null;
    entry.inFlight += 1;
    return this.lease(key, "inFlight");
  }

  acquireDesktopStream(identity: OpenClawControlResourceIdentity): OpenClawControlLease | null {
    const key = this.key(identity);
    const entry = this.entry(key);
    if (entry.desktopStreams >= this.maxDesktopStreams) return null;
    entry.desktopStreams += 1;
    return this.lease(key, "desktopStreams");
  }

  consumeMutation(identity: OpenClawControlResourceIdentity): boolean {
    const key = this.key(identity);
    const entry = this.entry(key);
    const now = this.now();
    if (now - entry.mutationWindowStartedAt >= this.mutationWindowMs) {
      entry.mutationWindowStartedAt = now;
      entry.mutationCount = 0;
    }
    if (entry.mutationCount >= this.mutationLimit) return false;
    entry.mutationCount += 1;
    return true;
  }

  private key(identity: OpenClawControlResourceIdentity): string {
    return `${identity.uid}\0${identity.gatewayId}\0${identity.sessionId}`;
  }

  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        sockets: 0,
        desktopStreams: 0,
        inFlight: 0,
        mutationCount: 0,
        mutationWindowStartedAt: this.now(),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private lease(key: string, field: "sockets" | "desktopStreams" | "inFlight"): OpenClawControlLease {
    let active = true;
    return {
      release: () => {
        if (!active) throw new Error(`OpenClaw Dashboard ${field} lease already released`);
        active = false;
        const entry = this.entries.get(key);
        if (!entry || entry[field] <= 0) throw new Error(`OpenClaw Dashboard ${field} lease lost`);
        entry[field] -= 1;
        if (entry.sockets === 0 && entry.desktopStreams === 0 && entry.inFlight === 0 && entry.mutationCount === 0) {
          this.entries.delete(key);
        }
      },
    };
  }
}
