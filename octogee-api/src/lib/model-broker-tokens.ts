import * as crypto from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

export type ModelBrokerProvider = "anthropic";

export interface ModelBrokerTokenRecord {
  tokenHash: string;
  gatewayId: string;
  ownerUid: string | null;
  provider: ModelBrokerProvider;
  capped: true;
  secretName: string;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
  revokedAt?: number;
}

export interface IssueModelBrokerTokenInput {
  gatewayId: string;
  ownerUid?: string;
  provider: ModelBrokerProvider;
  secretName: string;
  ttlSeconds?: number | null;
  now?: number;
  randomBytes?: (size: number) => Buffer;
}

export interface RevokeModelBrokerTokenInput {
  gatewayId: string;
  ownerUid?: string;
  provider: ModelBrokerProvider;
  secretName: string;
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

function parseRecord(data: Record<string, unknown> | undefined): ModelBrokerTokenRecord | null {
  if (!data) return null;
  if (data.provider !== "anthropic") return null;
  if (data.capped !== true) return null;
  if (typeof data.tokenHash !== "string") return null;
  if (typeof data.gatewayId !== "string" || !data.gatewayId) return null;
  if (typeof data.secretName !== "string" || !data.secretName) return null;
  if (typeof data.createdAt !== "number") return null;
  const ownerUid = typeof data.ownerUid === "string" ? data.ownerUid : null;
  const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : null;
  const revokedAt = typeof data.revokedAt === "number" ? data.revokedAt : undefined;
  return {
    tokenHash: data.tokenHash,
    gatewayId: data.gatewayId,
    ownerUid,
    provider: "anthropic",
    capped: true,
    secretName: data.secretName,
    createdAt: data.createdAt,
    expiresAt,
    revoked: data.revoked === true,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
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
    const previousHash = this.pointers.get(input.gatewayId);
    if (previousHash && this.tokens.has(previousHash)) {
      const previous = this.tokens.get(previousHash)!;
      this.tokens.set(previousHash, {
        ...previous,
        revoked: true,
        revokedAt: now,
      });
    }
    const record: ModelBrokerTokenRecord = {
      tokenHash,
      gatewayId: input.gatewayId,
      ownerUid: input.ownerUid ?? null,
      provider: input.provider,
      capped: true,
      secretName: input.secretName,
      createdAt: now,
      expiresAt: ttl ? now + ttl * 1000 : null,
      revoked: false,
    };
    this.tokens.set(tokenHash, record);
    this.pointers.set(input.gatewayId, tokenHash);
    return { token, record };
  }

  async revokeGatewayToken(input: RevokeModelBrokerTokenInput): Promise<{ revoked: boolean }> {
    const tokenHash = this.pointers.get(input.gatewayId);
    if (!tokenHash) return { revoked: false };
    const existing = this.tokens.get(tokenHash);
    this.pointers.delete(input.gatewayId);
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
      const pointerRef = pointers.doc(input.gatewayId);
      const pointer = await pointerRef.get();
      const previousHash = pointer.exists
        ? (pointer.data() as { tokenHash?: unknown } | undefined)?.tokenHash
        : undefined;
      if (typeof previousHash === "string" && previousHash && previousHash !== tokenHash) {
        const previousRef = tokens.doc(previousHash);
        const previous = await previousRef.get();
        // A stale pointer should not create a revoked-only tombstone token doc.
        if (previous.exists) {
          await previousRef.set(
            { revoked: true, revokedAt: now },
            { merge: true },
          );
        }
      }

      const record: ModelBrokerTokenRecord = {
        tokenHash,
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid ?? null,
        provider: input.provider,
        capped: true,
        secretName: input.secretName,
        createdAt: now,
        expiresAt: ttl ? now + ttl * 1000 : null,
        revoked: false,
      };
      await tokens.doc(tokenHash).set(record);
      await pointerRef.set({
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid ?? null,
        provider: input.provider,
        secretName: input.secretName,
        tokenHash,
        updatedAt: now,
      });
      return { token, record };
    },

    async revokeGatewayToken(input) {
      const pointerRef = pointers.doc(input.gatewayId);
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
