import * as crypto from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

export type ModelBrokerProvider = "anthropic";

export interface ModelBrokerTokenLimits {
  spendWindowUsd: number | null;
  requestsPerMinute: number | null;
}

// Plan/routing policy, distinct from spend limits. `freeTier` means "always serve
// the house model on the house key, never billed" — degrade unconditionally rather
// than only on window exhaustion. Paid tiers carry `freeTier: false` and degrade
// only when their `spendWindowUsd` is exhausted.
export interface ModelBrokerTokenPolicy {
  freeTier: boolean;
}

export interface ModelBrokerTokenRecord {
  tokenHash: string;
  gatewayId: string;
  ownerUid: string | null;
  provider: ModelBrokerProvider;
  capped: true;
  secretName: string;
  createdAt: number;
  expiresAt: number | null;
  limits: ModelBrokerTokenLimits;
  policy: ModelBrokerTokenPolicy;
  revoked: boolean;
  revokedAt?: number;
}

export interface IssueModelBrokerTokenInput {
  gatewayId: string;
  ownerUid?: string;
  provider: ModelBrokerProvider;
  secretName: string;
  // Revocation scope. Defaults to gatewayId (one active token per gateway, for
  // single-tenant builder/operator pods). A multi-tenant shared pod issues one
  // owner-scoped token per customer-agent, so it passes `${gatewayId}:${ownerUid}`
  // to keep each customer's pointer independent — reissuing one customer's token
  // must not revoke a sibling's.
  pointerKey?: string;
  // Mint a standalone token with NO pointer (no revoke-on-reissue). Per-customer
  // shared tokens are re-minted whenever the secret-resolver re-resolves the keyRef,
  // so skipPointer prevents a re-mint from yanking a still-in-flight token — stale
  // tokens expire by TTL instead. Requires ttlSeconds to bound accumulation.
  skipPointer?: boolean;
  ttlSeconds?: number | null;
  limits?: Partial<ModelBrokerTokenLimits> | null;
  policy?: Partial<ModelBrokerTokenPolicy> | null;
  now?: number;
  randomBytes?: (size: number) => Buffer;
}

export interface RevokeModelBrokerTokenInput {
  gatewayId: string;
  ownerUid?: string;
  provider: ModelBrokerProvider;
  secretName: string;
  pointerKey?: string;
  now?: number;
}

export interface ModelBrokerTokenStore {
  issueToken(input: IssueModelBrokerTokenInput): Promise<{
    token: string;
    record: ModelBrokerTokenRecord;
  }>;
  revokeGatewayToken(input: RevokeModelBrokerTokenInput): Promise<{ revoked: boolean }>;
  lookupToken(token: string, now?: number): Promise<ModelBrokerTokenRecord | null>;
}

export const MODEL_BROKER_TOKENS_COLLECTION = "modelBrokerTokens";
export const MODEL_BROKER_GATEWAY_POINTERS_COLLECTION = "modelBrokerGatewayTokens";

export function hashModelBrokerToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeTtlSeconds(ttlSeconds: number | null | undefined): number | null {
  if (ttlSeconds === null || ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return null;
  return Math.floor(ttlSeconds);
}

function nonNegativeLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeModelBrokerTokenLimits(
  limits: Partial<ModelBrokerTokenLimits> | null | undefined,
): ModelBrokerTokenLimits {
  return {
    spendWindowUsd: nonNegativeLimit(limits?.spendWindowUsd),
    requestsPerMinute: nonNegativeLimit(limits?.requestsPerMinute),
  };
}

export function normalizeModelBrokerTokenPolicy(
  policy: Partial<ModelBrokerTokenPolicy> | null | undefined,
): ModelBrokerTokenPolicy {
  return {
    freeTier: policy?.freeTier === true,
  };
}

function parseRecord(data: Record<string, unknown> | undefined): ModelBrokerTokenRecord | null {
  if (!recordHasRequiredShape(data)) return null;
  const ownerUid = typeof data.ownerUid === "string" ? data.ownerUid : null;
  const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : null;
  const revokedAt = typeof data.revokedAt === "number" ? data.revokedAt : undefined;
  const limits =
    data.limits && typeof data.limits === "object" && !Array.isArray(data.limits)
      ? normalizeModelBrokerTokenLimits(data.limits as Partial<ModelBrokerTokenLimits>)
      : normalizeModelBrokerTokenLimits(null);
  const policy =
    data.policy && typeof data.policy === "object" && !Array.isArray(data.policy)
      ? normalizeModelBrokerTokenPolicy(data.policy as Partial<ModelBrokerTokenPolicy>)
      : normalizeModelBrokerTokenPolicy(null);
  return {
    tokenHash: data.tokenHash,
    gatewayId: data.gatewayId,
    ownerUid,
    provider: "anthropic",
    capped: true,
    secretName: data.secretName,
    createdAt: data.createdAt,
    expiresAt,
    limits,
    policy,
    revoked: data.revoked === true,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function recordHasRequiredShape(data: Record<string, unknown> | undefined): data is Record<string, unknown> & {
  tokenHash: string;
  gatewayId: string;
  secretName: string;
  createdAt: number;
} {
  if (!data) return false;
  return [
    data.provider === "anthropic",
    data.capped === true,
    typeof data.tokenHash === "string",
    typeof data.gatewayId === "string" && data.gatewayId.length > 0,
    typeof data.secretName === "string" && data.secretName.length > 0,
    typeof data.createdAt === "number",
  ].every(Boolean);
}

export class InMemoryModelBrokerTokenStore implements ModelBrokerTokenStore {
  private readonly tokens = new Map<string, ModelBrokerTokenRecord>();
  private readonly pointers = new Map<string, string>();

  async issueToken(input: IssueModelBrokerTokenInput): Promise<{
    token: string;
    record: ModelBrokerTokenRecord;
  }> {
    const now = input.now ?? Date.now();
    const ttl = normalizeTtlSeconds(input.ttlSeconds);
    const randomBytes = input.randomBytes ?? crypto.randomBytes;
    const token = `ogk_${input.gatewayId}_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashModelBrokerToken(token);
    const record: ModelBrokerTokenRecord = {
      tokenHash,
      gatewayId: input.gatewayId,
      ownerUid: input.ownerUid ?? null,
      provider: input.provider,
      capped: true,
      secretName: input.secretName,
      createdAt: now,
      expiresAt: ttl ? now + ttl * 1000 : null,
      limits: normalizeModelBrokerTokenLimits(input.limits),
      policy: normalizeModelBrokerTokenPolicy(input.policy),
      revoked: false,
    };
    this.tokens.set(tokenHash, record);
    if (!input.skipPointer) {
      const pointerKey = input.pointerKey ?? input.gatewayId;
      const previousHash = this.pointers.get(pointerKey);
      if (previousHash && previousHash !== tokenHash && this.tokens.has(previousHash)) {
        const previous = this.tokens.get(previousHash)!;
        this.tokens.set(previousHash, { ...previous, revoked: true, revokedAt: now });
      }
      this.pointers.set(pointerKey, tokenHash);
    }
    return { token, record };
  }

  async revokeGatewayToken(input: RevokeModelBrokerTokenInput): Promise<{ revoked: boolean }> {
    const pointerKey = input.pointerKey ?? input.gatewayId;
    const tokenHash = this.pointers.get(pointerKey);
    if (!tokenHash) return { revoked: false };
    const existing = this.tokens.get(tokenHash);
    this.pointers.delete(pointerKey);
    if (!existing || existing.provider !== input.provider || existing.secretName !== input.secretName) {
      return { revoked: false };
    }
    this.tokens.set(tokenHash, {
      ...existing,
      revoked: true,
      revokedAt: input.now ?? Date.now(),
    });
    return { revoked: true };
  }

  async lookupToken(token: string, now = Date.now()): Promise<ModelBrokerTokenRecord | null> {
    const record = this.tokens.get(hashModelBrokerToken(token));
    if (!record || record.revoked) return null;
    if (record.expiresAt !== null && record.expiresAt <= now) return null;
    return record;
  }
}

export function createFirestoreModelBrokerTokenStore(
  db: Pick<Firestore, "collection">,
): ModelBrokerTokenStore {
  const tokens = db.collection(MODEL_BROKER_TOKENS_COLLECTION);
  const pointers = db.collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION);

  return {
    async issueToken(input) {
      const now = input.now ?? Date.now();
      const ttl = normalizeTtlSeconds(input.ttlSeconds);
      const randomBytes = input.randomBytes ?? crypto.randomBytes;
      const token = `ogk_${input.gatewayId}_${randomBytes(32).toString("base64url")}`;
      const tokenHash = hashModelBrokerToken(token);
      const record: ModelBrokerTokenRecord = {
        tokenHash,
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid ?? null,
        provider: input.provider,
        capped: true,
        secretName: input.secretName,
        createdAt: now,
        expiresAt: ttl ? now + ttl * 1000 : null,
        limits: normalizeModelBrokerTokenLimits(input.limits),
        policy: normalizeModelBrokerTokenPolicy(input.policy),
        revoked: false,
      };
      await tokens.doc(tokenHash).set(record);
      if (!input.skipPointer) {
        const pointerKey = input.pointerKey ?? input.gatewayId;
        const pointerRef = pointers.doc(pointerKey);
        const pointer = await pointerRef.get();
        const previousHash = pointer.exists
          ? (pointer.data() as { tokenHash?: unknown } | undefined)?.tokenHash
          : undefined;
        if (typeof previousHash === "string" && previousHash && previousHash !== tokenHash) {
          const previousRef = tokens.doc(previousHash);
          const previous = await previousRef.get();
          // A stale pointer should not create a revoked-only tombstone token doc.
          if (previous.exists) {
            await previousRef.set({ revoked: true, revokedAt: now }, { merge: true });
          }
        }
        await pointerRef.set({
          gatewayId: input.gatewayId,
          ownerUid: input.ownerUid ?? null,
          provider: input.provider,
          secretName: input.secretName,
          tokenHash,
          updatedAt: now,
        });
      }
      return { token, record };
    },

    async revokeGatewayToken(input) {
      const pointerKey = input.pointerKey ?? input.gatewayId;
      const pointerRef = pointers.doc(pointerKey);
      const pointer = await pointerRef.get();
      if (!pointer.exists) return { revoked: false };
      const data = pointer.data() as
        | {
            tokenHash?: unknown;
            provider?: unknown;
            secretName?: unknown;
          }
        | undefined;
      const tokenHash = typeof data?.tokenHash === "string" ? data.tokenHash : "";
      if (!tokenHash || data?.provider !== input.provider || data?.secretName !== input.secretName) {
        return { revoked: false };
      }
      await tokens.doc(tokenHash).set(
        { revoked: true, revokedAt: input.now ?? Date.now() },
        { merge: true },
      );
      await pointerRef.delete();
      return { revoked: true };
    },

    async lookupToken(token, now = Date.now()) {
      const snap = await tokens.doc(hashModelBrokerToken(token)).get();
      if (!snap.exists) return null;
      const record = parseRecord(snap.data() as Record<string, unknown> | undefined);
      if (!record || record.revoked) return null;
      if (record.expiresAt !== null && record.expiresAt <= now) return null;
      return record;
    },
  };
}
