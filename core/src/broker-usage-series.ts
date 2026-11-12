// The admin usage panel's cost source. The gateway self-report ledger
// (workspaces/{slug}/usage_models) records openclaw's own cost, which is $0 for
// OpenRouter/GLM calls — the agent runtime never sees OpenRouter's price. The
// LLM broker DOES (it injects usage:{include:true} and meters the reported
// cost, #2114), so the per-owner event stream is the billing truth. This
// aggregates it per model + per date for the Ops panel.
//
// Owner-credential traffic (BYOSUB/BYOK) bypasses the broker and carries $0
// platform cost by definition, so it is absent here — correct for a platform
// cost panel.

export const BROKER_USAGE_SERIES_READ_LIMIT = 20_000;

export interface BrokerModelUsage {
  model: string;
  tokens: number;
  costUsd: number;
  calls: number;
  lastUsedAt: number | null;
}

export interface BrokerDateUsage {
  date: string;
  tokens: number;
  costUsd: number;
  calls: number;
}

export interface BrokerUsageSeries {
  models: BrokerModelUsage[];
  sessions: BrokerDateUsage[];
  totalTokens: number;
  totalCostUsd: number;
  totalCalls: number;
  truncated: boolean;
}

function num(data: Readonly<Record<string, unknown>>, key: string): number {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function dayOf(createdAtMs: number): string {
  return new Date(createdAtMs).toISOString().slice(0, 10);
}

export function brokerUsageSeries(events: readonly Readonly<Record<string, unknown>>[]): BrokerUsageSeries {
  const byModel = new Map<string, BrokerModelUsage>();
  const byDate = new Map<string, BrokerDateUsage>();
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const data of events) {
    const createdAt = num(data, "createdAt");
    // Skip events with a missing/invalid createdAt (0) so they never group under
    // 1970-01-01 or poison lastUsedAt — matches readBrokerDailyUsage.
    if (createdAt <= 0) continue;
    const model = typeof data.model === "string" ? data.model : "unknown";
    const tokens = num(data, "totalTokens");
    const costUsd = num(data, "costUsd");

    const m = byModel.get(model) ?? { model, tokens: 0, costUsd: 0, calls: 0, lastUsedAt: null };
    m.tokens += tokens;
    m.costUsd += costUsd;
    m.calls += 1;
    m.lastUsedAt = m.lastUsedAt === null ? createdAt : Math.max(m.lastUsedAt, createdAt);
    byModel.set(model, m);

    const date = dayOf(createdAt);
    const d = byDate.get(date) ?? { date, tokens: 0, costUsd: 0, calls: 0 };
    d.tokens += tokens;
    d.costUsd += costUsd;
    d.calls += 1;
    byDate.set(date, d);

    totalTokens += tokens;
    totalCostUsd += costUsd;
  }

  return {
    models: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    sessions: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)),
    totalTokens,
    totalCostUsd,
    totalCalls: events.length,
    truncated: events.length >= BROKER_USAGE_SERIES_READ_LIMIT,
  };
}
