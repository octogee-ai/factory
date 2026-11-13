import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresSecretStore, createSecretStoreKeyRing } from "../../../postgres-secret-store.js";
import { SecretNotFoundError } from "../../../secret-store-types.js";
import { createHarness, dsn, type PlatformStateHarness } from "./fixtures/harness.js";

const firstKey = Buffer.alloc(32, 1).toString("base64");
const secondKey = Buffer.alloc(32, 2).toString("base64");

describe.skipIf(!dsn)("PostgreSQL runtime secret store", () => {
  let harness: PlatformStateHarness;
  let store: ReturnType<typeof createPostgresSecretStore>;

  beforeEach(async () => {
    harness = await createHarness();
    store = createPostgresSecretStore(harness.pool, createSecretStoreKeyRing(firstKey), harness.schema);
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("preserves labels and versioned credentials while storing only authenticated ciphertext", async () => {
    await store.writeSecret({ name: "provider-key", value: "first value", labels: { scope: "owner" } });
    await store.addSecretVersionIfExists("provider-key", "second value");

    await expect(store.readSecretWithLabels("provider-key")).resolves.toEqual({
      value: "second value",
      labels: { scope: "owner" },
    });
    await expect(store.readSecret("provider-key", "1")).resolves.toBe("first value");
    const rows = await harness.query("SELECT key_id, ciphertext FROM $schema.runtime_secret_versions");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => typeof row.key_id === "string")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/first value|second value/);
  });

  it("deduplicates and bounds repeated credential saves", async () => {
    const first = await store.writeSecret({ name: "session", value: "initial" });
    expect(await store.writeSecret({ name: "session", value: "initial", labels: { role: "updated" } })).toEqual(first);
    expect(await store.readSecretWithLabels("session")).toEqual({ value: "initial", labels: { role: "updated" } });

    for (let version = 2; version <= 9; version++) {
      await store.writeSecret({ name: "session", value: `token ${version}` });
    }
    expect(await store.addSecretVersionIfExists("session", "token 9")).toEqual({ ok: true, versionName: "secrets/session/versions/9" });
    expect(await harness.query("SELECT version FROM $schema.runtime_secret_versions ORDER BY version"))
      .toEqual([5, 6, 7, 8, 9].map(version => ({ version })));
    await expect(store.readSecret("session", "4")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("prunes superseded subscription versions and serializes concurrent refreshes", async () => {
    await store.writeSecret({ name: "session", value: "old" });
    const first = await store.addSecretVersionKeepingLatest("session", "old");
    expect(first).toEqual({ ok: true, changed: false, destroyed: 0 });

    await Promise.all([
      store.addSecretVersionKeepingLatest("session", "refresh A"),
      store.addSecretVersionKeepingLatest("session", "refresh B"),
    ]);
    const latest = await store.readSecret("session");
    expect(["refresh A", "refresh B"]).toContain(latest);
    await expect(store.readSecret("session", "1")).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(await harness.query("SELECT version FROM $schema.runtime_secret_versions"))
      .toEqual([{ version: 3 }]);
  });

  it("archives all live versions and deletes a secret idempotently", async () => {
    await store.writeSecret({ name: "archived", value: "v1" });
    await store.addSecretVersionIfExists("archived", "v2");
    await expect(store.archiveSecret("archived")).resolves.toEqual({ disabledCount: 2 });
    await expect(store.readSecret("archived")).rejects.toThrow(/disabled/);
    await expect(store.archiveSecret("archived")).resolves.toEqual({ disabledCount: 0 });
    await expect(store.deleteSecret("archived")).resolves.toEqual({ deleted: true });
    await expect(store.deleteSecret("archived")).resolves.toEqual({ deleted: false });
    await expect(store.addSecretVersionIfExists("archived", "v3"))
      .resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("rotates every version atomically and fences writers that only know the old key", async () => {
    await store.writeSecret({ name: "key", value: "old credential" });
    const transition = createPostgresSecretStore(
      harness.pool, createSecretStoreKeyRing(secondKey, firstKey), harness.schema,
    );
    await transition.addSecretVersionIfExists("key", "during rollout");

    await expect(transition.rotate()).resolves.toEqual({ rotated: 2 });
    await expect(transition.rotate()).resolves.toEqual({ rotated: 0 });
    const next = createPostgresSecretStore(harness.pool, createSecretStoreKeyRing(secondKey), harness.schema);
    await expect(next.readSecret("key", "1")).resolves.toBe("old credential");
    await expect(next.readSecret("key")).resolves.toBe("during rollout");
    await expect(store.writeSecret({ name: "other", value: "stale writer" })).rejects.toThrow(/unavailable key/);
    await expect(next.readSecret("other")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("rolls back the entire rotation when any ciphertext fails authentication", async () => {
    await store.writeSecret({ name: "first", value: "good" });
    await store.writeSecret({ name: "second", value: "tampered" });
    await harness.query("UPDATE $schema.runtime_secret_versions SET ciphertext = 'invalid' WHERE name = 'second'");
    const transition = createPostgresSecretStore(
      harness.pool, createSecretStoreKeyRing(secondKey, firstKey), harness.schema,
    );

    await expect(transition.rotate()).rejects.toThrow();
    await expect(store.readSecret("first")).resolves.toBe("good");
    await expect(store.addSecretVersionIfExists("first", "still writing")).resolves.toMatchObject({ ok: true });
  });
});
