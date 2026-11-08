import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlatformReleaseRecord, platformReleaseRecord } from "@octogee/shared/types/gateway-releases";
import type { SharedPoolScalerState } from "../../controller-state.js";
import { FenceMismatchError, MalformedRecordError, MissingRecordError } from "../../errors.js";
import { createHarness, dsn, type PlatformStateHarness } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const REPLACEMENT = { sourceGatewayId: "shared-0", targetGatewayId: "shared-3", updatedAt: NOW };

function retireState(overrides: Partial<SharedPoolScalerState> = {}): SharedPoolScalerState {
  return {
    schemaVersion: 1,
    replacements: [REPLACEMENT],
    actionSequence: 4,
    lastActionAt: NOW,
    lastAction: {
      operationId: "shared-pool-scale-00000004",
      gatewayId: "shared-0",
      fromDesiredStatus: "running",
      toDesiredStatus: "draining",
      decision: "drain",
    },
    updatedAt: NOW,
    ...overrides,
  };
}

function mintState(): SharedPoolScalerState {
  return { schemaVersion: 1, actionSequence: 1, lastActionAt: NOW, replacements: [] };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe.skipIf(!dsn)("PostgreSQL controller state", () => {
  let harness: PlatformStateHarness;
  const scaler = () => harness.store.controllerState.sharedPoolScaler;
  const platformRelease = () => harness.store.controllerState.platformRelease;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("shared pool scaler state", () => {
    it("reads absent state as null", async () => {
      expect(await scaler().get()).toBeNull();
      expect(await platformRelease().get()).toBeNull();
    });

    it("puts the first state only when absent and reads it back whole", async () => {
      await scaler().put(retireState({ actionSequence: 0 }), "absent");
      expect(await scaler().get()).toEqual({ ...retireState({ actionSequence: 0 }), revision: expect.stringMatching(/^\d+$/) });

      const current = await scaler().get();
      expect(await failure(scaler().put(retireState(), "absent"))).toMatchObject({
        constructor: FenceMismatchError,
        fence: "absent",
        expected: "absent",
        actual: current?.revision,
      });
    });

    it("reads state first written without lastAction or updatedAt without those fields", async () => {
      await scaler().put(mintState(), "absent");

      const state = await scaler().get();
      expect(state).toEqual({ ...mintState(), revision: expect.any(String) });
      expect(state).not.toHaveProperty("lastAction");
      expect(state).not.toHaveProperty("updatedAt");
    });

    it("replaces the whole state only under matching fences, dropping fields the new state lacks", async () => {
      await scaler().put(retireState({ actionSequence: 0 }), "absent");
      const current = await scaler().get();

      await scaler().put({ ...mintState(), lastAction: null }, { revision: current?.revision, actionSequence: 0 });
      const replaced = await scaler().get();
      expect(replaced).toEqual({ ...mintState(), lastAction: null, revision: expect.any(String) });
      expect(replaced).not.toHaveProperty("updatedAt");

      expect(await failure(scaler().put(retireState({ actionSequence: 2 }), { actionSequence: 0 }))).toMatchObject({
        constructor: FenceMismatchError,
        fence: "actionSequence",
        expected: 0,
        actual: 1,
      });
      expect(await failure(scaler().put(retireState(), { revision: current?.revision }))).toMatchObject({
        constructor: FenceMismatchError,
        fence: "revision",
      });
    });

    it("refuses to put over a missing state without the absent fence", async () => {
      expect(await failure(scaler().put(retireState(), { actionSequence: 0 }))).toMatchObject({
        constructor: MissingRecordError,
        record: { aggregate: "shared-pool-scaler", key: "sharedPoolScaler" },
      });
    });

    it("refuses to store state the scaler parser would reject", async () => {
      const refused = await Promise.all([
        failure(scaler().put(retireState({ replacements: [REPLACEMENT, REPLACEMENT] }), "absent")),
        failure(scaler().put(retireState({ actionSequence: -1 }), "absent")),
        failure(scaler().put(retireState({ lastActionAt: 1.5 }), "absent")),
        failure(scaler().put(retireState({ lastAction: [] as never }), "absent")),
        failure(scaler().put(retireState({ schemaVersion: 2 as never }), "absent")),
      ]);
      for (const error of refused) expect(error).toBeInstanceOf(MalformedRecordError);
      expect(await scaler().get()).toBeNull();
    });

    it("patches the sequence under its fence and refuses a patch that would store invalid state", async () => {
      await scaler().put(retireState(), "absent");

      await scaler().patch({ replacements: [], actionSequence: 5, lastActionAt: NOW + 1 }, { actionSequence: 4 });
      expect(await scaler().get()).toEqual({ ...retireState({ replacements: [], actionSequence: 5, lastActionAt: NOW + 1 }), revision: expect.any(String) });

      await scaler().patch({ lastAction: { clear: true }, updatedAt: { clear: true } });
      expect(await scaler().get()).not.toHaveProperty("lastAction");

      expect(await failure(scaler().patch({ actionSequence: 6 }, { actionSequence: 4 }))).toBeInstanceOf(FenceMismatchError);
      expect(await failure(scaler().patch({ actionSequence: -1 }))).toBeInstanceOf(MalformedRecordError);
      expect(await failure(scaler().patch({ lastActionAt: { clear: true } }))).toBeInstanceOf(MalformedRecordError);
      expect(await failure(scaler().patch({ replacements: [REPLACEMENT, REPLACEMENT] }))).toBeInstanceOf(MalformedRecordError);
      expect((await scaler().get())?.actionSequence).toBe(5);
    });

    it("refuses to patch missing state", async () => {
      expect(await failure(scaler().patch({ actionSequence: 1 }))).toBeInstanceOf(MissingRecordError);
    });

    it("advances the sequence exactly once when two transactions race under the same fence", async () => {
      await scaler().put(retireState(), "absent");

      const advance = () =>
        harness.store.transaction({ label: "scale" }, async (tx) => {
          const state = await tx.controllerState.sharedPoolScaler.get();
          await tx.controllerState.sharedPoolScaler.patch({ actionSequence: state!.actionSequence + 1 }, { actionSequence: state!.actionSequence });
        });
      const results = await Promise.allSettled([advance(), advance()]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect((await scaler().get())?.actionSequence).toBe(6);
    });
  });

  describe("platform release record", () => {
    const record = platformReleaseRecord(
      { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway", imageTag: "753c212", openclawSourceSha: "abc123" },
      NOW,
    );

    it("puts the record today's parser reads and replaces it on the next put", async () => {
      await platformRelease().put(record);

      const stored = await platformRelease().get();
      const { revision, ...value } = stored!;
      expect(value).toEqual(record);
      expect(parsePlatformReleaseRecord(value)).toEqual(record);
      expect(revision).toMatch(/^\d+$/);

      await platformRelease().put({ ...record, openclawSourceSha: null, writtenAt: NOW + 1 });
      expect(await platformRelease().get()).toMatchObject({ openclawSourceSha: null, writtenAt: NOW + 1 });
    });

    it("refuses to write or read a record the parser rejects", async () => {
      expect(await failure(platformRelease().put({ ...record, payloadHash: "short" }))).toBeInstanceOf(MalformedRecordError);
      expect(await platformRelease().get()).toBeNull();

      await platformRelease().put(record);
      await harness.query("UPDATE $schema.platform_release_record SET image_tag = ''");
      expect(await failure(platformRelease().get())).toBeInstanceOf(MalformedRecordError);
    });
  });
});
