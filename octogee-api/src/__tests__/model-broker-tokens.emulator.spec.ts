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
} from "@shared/test-helpers/firestore-emulator.js";

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
