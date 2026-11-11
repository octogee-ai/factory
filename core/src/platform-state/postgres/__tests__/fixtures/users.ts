import { afterEach, beforeEach } from "vitest";
import type { UserActivationLease, PlatformUserRecord, UserRecordsRepository, UserRepositories } from "../../../users.js";
import type { PlatformStateStore, Stored } from "../../../store.js";
import type { Row } from "../../sql.js";
import { createHarness, type PlatformStateHarness } from "./harness.js";

export const NOW = 1_762_500_000_000;
export const DAY = 24 * 60 * 60_000;
export const REVISION = /^\d+$/;

export interface UserFixture {
  readonly harness: PlatformStateHarness;
  readonly store: PlatformStateStore;
  readonly users: UserRepositories;
  readonly records: UserRecordsRepository;
  gateway(gatewayId: string): Promise<void>;
  assign(gatewayId: string, uid: string, slug?: string): Promise<void>;
  place(uid: string, gatewayId: string): Promise<void>;
  admitted(uid: string, slug?: string): Promise<void>;
  row(table: string, where: string, values: readonly unknown[]): Promise<Row | undefined>;
  count(table: string, uid: string): Promise<number>;
}

function fixtureFor(harness: PlatformStateHarness): UserFixture {
  const { store } = harness;
  const fixture: UserFixture = {
    harness,
    store,
    users: store.users,
    records: store.users.records,
    async gateway(gatewayId) {
      await harness.query(
        `INSERT INTO $schema.gateways (gateway_id, created_at, created_by, updated_at, updated_by, latest_release, desired_release,
           desired_status, config_schema_version, gateway_class, image_profile)
         VALUES ($1::text, 1, 'test', 1, 'test', 0, 0, 'running', 1, $2::text, 'standard') ON CONFLICT DO NOTHING`,
        [gatewayId, gatewayId.startsWith("shared-") ? "shared" : "builder"],
      );
    },
    async assign(gatewayId, uid, slug = uid) {
      await fixture.gateway(gatewayId);
      await harness.query(
        `INSERT INTO $schema.gateway_assignments (gateway_id, uid, slug, source, state, epoch, created_at, updated_at)
         VALUES ($1::text, $2::text, $3::text, 'onboarding', 'serving', 0, 1, 1)`,
        [gatewayId, uid, slug],
      );
    },
    async place(uid, gatewayId) {
      await fixture.assign(gatewayId, uid);
      await store.users.records.setGatewayMirror(uid, { gatewayId });
    },
    async admitted(uid, slug = uid) {
      await store.users.records.admit(uid, { slug, persona: null, provisioningStartedAt: NOW });
    },
    async row(table, where, values) {
      const rows = await harness.query(`SELECT * FROM $schema.${table} WHERE ${where}`, values);
      return rows[0];
    },
    async count(table, uid) {
      const rows = await harness.query(`SELECT count(*)::int AS count FROM $schema.${table} WHERE uid = $1::text`, [uid]);
      return rows[0].count as number;
    },
  };
  return fixture;
}

export function useUserFixture(): () => UserFixture {
  let fixture: UserFixture | undefined;
  beforeEach(async () => {
    fixture = fixtureFor(await createHarness());
  });
  afterEach(async () => {
    await fixture?.harness.dispose();
    fixture = undefined;
  });
  return () => {
    if (fixture === undefined) throw new Error("the user fixture is only available inside a test");
    return fixture;
  };
}

export function lease(overrides: Partial<UserActivationLease> = {}): UserActivationLease {
  return {
    leaseId: "lease-1",
    generation: 1,
    status: "requested",
    cause: "chat",
    eventKey: "event-1",
    requestedAt: NOW,
    lastActiveAt: NOW,
    requestedBy: "gateway-edge",
    builderSlug: "alice",
    sourceGatewayId: "shared-a",
    sourceAssignmentEpoch: 4,
    entitlementTier: "pro",
    sizingTier: "pro",
    ...overrides,
  };
}

export function uids(records: readonly Stored<PlatformUserRecord>[]): string[] {
  return records.map((record) => record.uid).sort();
}
