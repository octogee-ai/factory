import { describe, expect, it } from "vitest";

import {
  MODEL_BROKER_GATEWAY_POINTERS_COLLECTION,
  MODEL_BROKER_TOKENS_COLLECTION,
  createFirestoreModelBrokerTokenStore,
  hashModelBrokerToken,
} from "../lib/model-broker-tokens.js";
import {
  getAdminDb,
  setupEmulatorTest,
} from "@octogee/test-helpers/firestore-emulator";

setupEmulatorTest();

const gatewayTokenInput = {
  gatewayId: "jack",
  ownerUid: "uid-jack",
  provider: "anthropic" as const,
  secretName: "gateway-model-key-jack",
};

function randomBytes(fill: number): (size: number) => Buffer {
  return (size) => Buffer.alloc(size, fill);
}

describe("Firestore model broker token store", () => {
  it("issues, looks up, revokes the previous token on reissue, and revokes active tokens", async () => {
    const db = getAdminDb();
    const store = createFirestoreModelBrokerTokenStore(db);

    const first = await store.issueToken({
      ...gatewayTokenInput,
      now: 1_000,
      randomBytes: randomBytes(1),
    });

    await expect(store.lookupToken(first.token, 1_001)).resolves.toMatchObject({
      gatewayId: "jack",
      ownerUid: "uid-jack",
      provider: "anthropic",
      capped: true,
      revoked: false,
    });

    const second = await store.issueToken({
      ...gatewayTokenInput,
      now: 2_000,
      randomBytes: randomBytes(2),
    });

    expect(second.token).not.toBe(first.token);
    await expect(store.lookupToken(first.token, 2_001)).resolves.toBeNull();
    await expect(store.lookupToken(second.token, 2_001)).resolves.toMatchObject({
      gatewayId: "jack",
      revoked: false,
    });

    const pointer = await db
      .collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION)
      .doc("jack")
      .get();
    expect(pointer.data()).toMatchObject({
      tokenHash: hashModelBrokerToken(second.token),
      gatewayId: "jack",
      secretName: "gateway-model-key-jack",
    });

    await expect(
      store.revokeGatewayToken({ ...gatewayTokenInput, now: 3_000 }),
    ).resolves.toEqual({ revoked: true });
    await expect(store.lookupToken(second.token, 3_001)).resolves.toBeNull();
    const deletedPointer = await db
      .collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION)
      .doc("jack")
      .get();
    expect(deletedPointer.exists).toBe(false);
  });

  it("scopes revocation by pointerKey so per-customer tokens on a shared gateway are independent", async () => {
    const db = getAdminDb();
    const store = createFirestoreModelBrokerTokenStore(db);

    const perCustomer = (ownerUid: string, fill: number, now: number) =>
      store.issueToken({
        gatewayId: "shared-1",
        ownerUid,
        provider: "anthropic" as const,
        secretName: `agent-model-token-shared-1-${ownerUid}`,
        pointerKey: `shared-1:${ownerUid}`,
        limits: null,
        now,
        randomBytes: randomBytes(fill),
      });

    const alice = await perCustomer("uid-alice", 10, 1_000);
    const bob = await perCustomer("uid-bob", 11, 1_000);

    // meter-only: no caps stamped
    await expect(store.lookupToken(alice.token, 1_001)).resolves.toMatchObject({
      ownerUid: "uid-alice",
      revoked: false,
      limits: { spendWindowUsd: null, requestsPerMinute: null },
    });
    // issuing bob did NOT revoke alice (same gateway, different pointerKey)
    await expect(store.lookupToken(bob.token, 1_001)).resolves.toMatchObject({
      ownerUid: "uid-bob",
      revoked: false,
    });

    // reissuing alice revokes only alice's previous token, never bob's
    const alice2 = await perCustomer("uid-alice", 12, 2_000);
    await expect(store.lookupToken(alice.token, 2_001)).resolves.toBeNull();
    await expect(store.lookupToken(alice2.token, 2_001)).resolves.toMatchObject({ revoked: false });
    await expect(store.lookupToken(bob.token, 2_001)).resolves.toMatchObject({ revoked: false });
  });

  it("skipPointer mints a standalone TTL-bounded token — a re-mint never revokes the in-flight one", async () => {
    const db = getAdminDb();
    const store = createFirestoreModelBrokerTokenStore(db);

    const mint = (fill: number, now: number) =>
      store.issueToken({
        gatewayId: "shared-1",
        ownerUid: "uid-alice",
        provider: "anthropic" as const,
        secretName: "agent-model-token-shared-1-uid-alice",
        skipPointer: true,
        ttlSeconds: 3600,
        limits: null,
        trace: {
          source: "shared_agent_model_token",
          ownerSlug: "alice",
          agentId: "octogee-alice-coach",
        },
        now,
        randomBytes: randomBytes(fill),
      });

    const first = await mint(20, 1_000);
    const second = await mint(21, 2_000);

    // the re-mint did NOT revoke the first (still-in-flight) token
    await expect(store.lookupToken(first.token, 2_001)).resolves.toMatchObject({ revoked: false });
    await expect(store.lookupToken(first.token, 2_001)).resolves.toMatchObject({
      trace: {
        source: "shared_agent_model_token",
        ownerSlug: "alice",
        agentId: "octogee-alice-coach",
      },
    });
    await expect(store.lookupToken(second.token, 2_001)).resolves.toMatchObject({ revoked: false });
    expect(first.record.expiresAt).toBe(1_000 + 3_600 * 1000);
    // no pointer doc is written for standalone tokens
    const pointer = await db
      .collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION)
      .doc("shared-1")
      .get();
    expect(pointer.exists).toBe(false);
    // and the stale token expires by TTL rather than being yanked
    await expect(store.lookupToken(first.token, 1_000 + 3_600 * 1000 + 1)).resolves.toBeNull();
  });

  it("fails closed for malformed token records", async () => {
    const db = getAdminDb();
    const store = createFirestoreModelBrokerTokenStore(db);
    const token = "ogk_jack_malformed";
    const tokenHash = hashModelBrokerToken(token);

    await db.collection(MODEL_BROKER_TOKENS_COLLECTION).doc(tokenHash).set({
      tokenHash,
      gatewayId: "jack",
      provider: "anthropic",
      capped: true,
      secretName: "gateway-model-key-jack",
      createdAt: "not-a-number",
      revoked: false,
    });

    await expect(store.lookupToken(token, 1_001)).resolves.toBeNull();
  });

  it("does not create revoked-only tombstone docs for stale reissue pointers", async () => {
    const db = getAdminDb();
    const store = createFirestoreModelBrokerTokenStore(db);

    await db.collection(MODEL_BROKER_GATEWAY_POINTERS_COLLECTION).doc("jack").set({
      gatewayId: "jack",
      provider: "anthropic",
      secretName: "gateway-model-key-jack",
      tokenHash: "missing-token-hash",
    });

    await store.issueToken({
      ...gatewayTokenInput,
      now: 4_000,
      randomBytes: randomBytes(4),
    });

    const staleToken = await db
      .collection(MODEL_BROKER_TOKENS_COLLECTION)
      .doc("missing-token-hash")
      .get();
    expect(staleToken.exists).toBe(false);
  });
});
