import pg from "pg";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./platform-state/postgres/migrate.js";

export type ModelBrokerSpendPeriod = "window" | "week";

const SPEND_PERIODS: readonly ModelBrokerSpendPeriod[] = ["window", "week"];

export interface ModelBrokerSpendTotals {
  readonly requestCount: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly chargeUsd: number;
}

export interface ModelBrokerUsageLedgerEntry {
  readonly eventId: string;
  readonly ownerKey: string;
  readonly createdAt: number;
  readonly event: Readonly<Record<string, unknown>>;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly chargeUsd: number;
  readonly spendPeriods: readonly { readonly period: ModelBrokerSpendPeriod; readonly startMs: number }[];
}

export interface ModelBrokerUsageLedger {
  record(entry: ModelBrokerUsageLedgerEntry): Promise<boolean>;
  readSpend(ownerKey: string, period: ModelBrokerSpendPeriod, startMs: number): Promise<ModelBrokerSpendTotals>;
  reserveRequest(rateKey: string, startMs: number): Promise<number>;
}

const NO_SPEND: ModelBrokerSpendTotals = Object.freeze({ requestCount: 0, totalTokens: 0, costUsd: 0, chargeUsd: 0 });

function invalid(field: string): never {
  throw new Error(`model broker usage entry has an invalid ${field}`);
}

function requireKey(value: string, field: string): string {
  return typeof value === "string" && value.length > 0 ? value : invalid(field);
}

function requireTime(value: number, field: string): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : invalid(field);
}

function requireAmount(value: number, field: string): number {
  return Number.isFinite(value) && value >= 0 ? value : invalid(field);
}

function validEntry(entry: ModelBrokerUsageLedgerEntry): ModelBrokerUsageLedgerEntry {
  requireKey(entry.eventId, "event id");
  requireKey(entry.ownerKey, "owner key");
  requireTime(entry.createdAt, "creation time");
  requireTime(entry.totalTokens, "token count");
  requireAmount(entry.costUsd, "cost");
  requireAmount(entry.chargeUsd, "charge");
  if (entry.event === null || typeof entry.event !== "object" || Array.isArray(entry.event)) invalid("event");
  for (const { period, startMs } of entry.spendPeriods) {
    if (!SPEND_PERIODS.includes(period)) invalid("spend period");
    requireTime(startMs, "spend period start");
  }
  return entry;
}

interface SpendRow {
  request_count: string;
  total_tokens: string;
  cost_usd: number;
  charge_usd: number;
}

export function createPostgresModelBrokerUsageLedger(
  pool: Pick<pg.Pool, "query">,
  schema = DEFAULT_PLATFORM_STATE_SCHEMA,
): ModelBrokerUsageLedger {
  const identifier = pg.escapeIdentifier(schema);
  const events = `${identifier}.model_broker_usage_events`;
  const spend = `${identifier}.model_broker_spend_periods`;
  const rate = `${identifier}.model_broker_rate_windows`;

  return {
    async record(input) {
      const entry = validEntry(input);
      const result = await pool.query<{ recorded: number }>(
        `WITH recorded AS (
           INSERT INTO ${events} (event_id, owner_key, created_at, event)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id
         ), added AS (
           INSERT INTO ${spend} AS current (owner_key, period, start_ms, request_count, total_tokens, cost_usd, charge_usd)
           SELECT $2, spend.period, spend.start_ms, 1, $5, $6, $7
             FROM recorded, unnest($8::text[], $9::bigint[]) AS spend(period, start_ms)
           ON CONFLICT (owner_key, period, start_ms) DO UPDATE SET
             request_count = current.request_count + 1,
             total_tokens = current.total_tokens + EXCLUDED.total_tokens,
             cost_usd = current.cost_usd + EXCLUDED.cost_usd,
             charge_usd = current.charge_usd + EXCLUDED.charge_usd
         )
         SELECT count(*)::int AS recorded FROM recorded`,
        [
          entry.eventId,
          entry.ownerKey,
          entry.createdAt,
          JSON.stringify(entry.event),
          entry.totalTokens,
          entry.costUsd,
          entry.chargeUsd,
          entry.spendPeriods.map(({ period }) => period),
          entry.spendPeriods.map(({ startMs }) => startMs),
        ],
      );
      return result.rows[0]?.recorded === 1;
    },

    async readSpend(ownerKey, period, startMs) {
      const result = await pool.query<SpendRow>(
        `SELECT request_count, total_tokens, cost_usd, charge_usd FROM ${spend}
          WHERE owner_key = $1 AND period = $2 AND start_ms = $3`,
        [ownerKey, period, startMs],
      );
      const row = result.rows[0];
      if (!row) return NO_SPEND;
      return {
        requestCount: Number(row.request_count),
        totalTokens: Number(row.total_tokens),
        costUsd: row.cost_usd,
        chargeUsd: row.charge_usd,
      };
    },

    async reserveRequest(rateKey, startMs) {
      const result = await pool.query<{ request_count: number }>(
        `INSERT INTO ${rate} AS current (owner_key, start_ms, request_count) VALUES ($1, $2, 1)
         ON CONFLICT (owner_key, start_ms) DO UPDATE SET request_count = current.request_count + 1
         RETURNING request_count`,
        [requireKey(rateKey, "rate key"), requireTime(startMs, "rate window start")],
      );
      return result.rows[0].request_count;
    },
  };
}
