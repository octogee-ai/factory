import { describe, expect, it } from "vitest";

import {
  createFirestoreModelBrokerTokenStore,
  hashModelBrokerToken,
} from "../lib/model-broker-tokens.js";

const TOKEN = "ogk_jack_stored";

function storeWithRecord(data: Record<string, unknown>) {
  const docs = new Map<string, Record<string, unknown>>([[hashModelBrokerToken(TOKEN), data]]);
  const db = {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
      }),
    }),
  };
  return createFirestoreModelBrokerTokenStore(db as never);
}

function storedRecord(provider: string): Record<string, unknown> {
  return {
    tokenHash: hashModelBrokerToken(TOKEN),
    gatewayId: "jack",
    ownerUid: "uid-jack",
    provider,
    purpose: "model",
    capped: true,
    secretName: `agent-model-token-${provider}-jack-uid-jack`,
    createdAt: 1_000,
    expiresAt: null,
    revoked: false,
  };
}

describe("stored broker token record shape", () => {
  it("parses a vertex record on lookup", async () => {
    await expect(storeWithRecord(storedRecord("vertex")).lookupToken(TOKEN, 2_000)).resolves.toMatchObject({
      outcome: "valid",
      record: { provider: "vertex", gatewayId: "jack", ownerUid: "uid-jack" },
    });
  });

  it("still treats an unknown provider as an unknown token", async () => {
    await expect(storeWithRecord(storedRecord("bedrock")).lookupToken(TOKEN, 2_000)).resolves.toEqual({
      outcome: "unknown",
    });
  });
});
