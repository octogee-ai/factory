import {
  exhaustedSpendBudget,
  type ModelAccess,
  type SpendThrottleState,
} from "./model-broker-usage.js";

export type UserEntitlementInputs = object;
export type MaxProjects = number | "unlimited";
export type ProjectAccessMode = "active" | "archive_read";

export interface UserPlan {
  modelAccess: ModelAccess;
  spendWeekUsd: number;
  spendWindowUsd: number;
  toolAccess: boolean;
  houseFallback: boolean;
}

export interface ContextFilePolicy {
  templateKey: string;
  removedFiles: readonly string[];
}

export type ProductFields = Readonly<Record<string, unknown>>;

export interface UserProductProjection {
  agentUsageStatus(user: UserEntitlementInputs, now: Date): ProductFields;
  agentSupportUser(user: UserEntitlementInputs): ProductFields;
  agentModels(user: UserEntitlementInputs): ProductFields;
  adminUserSummary(
    user: UserEntitlementInputs,
    usage: { costUsd: number; now: Date },
  ): ProductFields;
  adminUserDetail(user: UserEntitlementInputs): ProductFields;
  adminUserStats(summaries: readonly ProductFields[]): ProductFields;
  adminUserArchive(record: Readonly<Record<string, unknown>>): ProductFields;
  provisionedUser(user: UserEntitlementInputs): ProductFields;
}

export interface UserSpendObservation {
  windowCostUsd: number;
  weekCostUsd: number;
  onOwnerCredential: boolean;
  creditBalanceUsd?: number | null;
}

export type PreviousImageWire =
  | "user-snapshot"
  | "restore-snapshot"
  | "model-pick-push"
  | "model-credential-push";

export type IsolatedGatewayAdmission =
  | { readonly admitted: true; readonly sizingKey: string }
  | { readonly admitted: false; readonly code: string; readonly reason: string };

export interface UserEntitlementResolver {
  plan(user: UserEntitlementInputs, now?: Date): UserPlan;
  sizingKey(user: UserEntitlementInputs, now?: Date): string | null;
  isolatedGatewayAdmission(user: UserEntitlementInputs, now?: Date): IsolatedGatewayAdmission;
  projectMode(user: UserEntitlementInputs, now?: Date): ProjectAccessMode;
  maxProjects(user: UserEntitlementInputs, now?: Date): MaxProjects;
  spendThrottle(plan: UserPlan, observation: UserSpendObservation): SpendThrottleState;
  pickInputs(source: Record<string, unknown>): Record<string, unknown>;
  contextFilePolicy(user: UserEntitlementInputs, now?: Date): ContextFilePolicy;
  seedContextTemplateKey(user: UserEntitlementInputs): string;
  previousImageFields(wire: PreviousImageWire, source: Record<string, unknown>): Record<string, unknown>;
  readonly productProjection?: UserProductProjection;
}

const UNMETERED_BUDGET_USD = Number.MAX_SAFE_INTEGER;
const STATIC_SIZING_KEY = "default";
const STATIC_CONTEXT_TEMPLATE_KEY = "default";

export const staticUserEntitlements: UserEntitlementResolver = {
  plan: () => ({
    modelAccess: "catalog",
    spendWeekUsd: UNMETERED_BUDGET_USD,
    spendWindowUsd: UNMETERED_BUDGET_USD,
    toolAccess: true,
    houseFallback: false,
  }),
  sizingKey: () => STATIC_SIZING_KEY,
  isolatedGatewayAdmission: () => ({
    admitted: false,
    code: "isolated-gateway-operator-grant-required",
    reason: "No admission policy is installed; an operator grants isolated gateways through the Admin API",
  }),
  projectMode: () => "active",
  maxProjects: () => "unlimited",
  spendThrottle: (plan, observation) => {
    const exhausted = observation.onOwnerCredential
      ? null
      : exhaustedSpendBudget({
          windowCostUsd: observation.windowCostUsd,
          windowBudgetUsd: plan.spendWindowUsd,
          weekCostUsd: observation.weekCostUsd,
          weekBudgetUsd: plan.spendWeekUsd,
        });
    if (!exhausted) return { degraded: false, blocked: false, reason: null };
    return {
      degraded: plan.houseFallback,
      blocked: !plan.houseFallback,
      reason: `${exhausted}_exhausted`,
    };
  },
  pickInputs: () => ({}),
  contextFilePolicy: () => ({ templateKey: STATIC_CONTEXT_TEMPLATE_KEY, removedFiles: [] }),
  seedContextTemplateKey: () => STATIC_CONTEXT_TEMPLATE_KEY,
  previousImageFields: () => ({}),
};

const RESOLVER_SLOT = Symbol.for("octogee.userEntitlements");
type ResolverHost = typeof globalThis & { [RESOLVER_SLOT]?: UserEntitlementResolver };

export function installUserEntitlements(resolver: UserEntitlementResolver): void {
  (globalThis as ResolverHost)[RESOLVER_SLOT] = resolver;
}

export function installDefaultUserEntitlements(): void {
  (globalThis as ResolverHost)[RESOLVER_SLOT] ??= staticUserEntitlements;
}

export function userEntitlements(): UserEntitlementResolver {
  const resolver = (globalThis as ResolverHost)[RESOLVER_SLOT];
  if (!resolver) throw new Error("User entitlements resolver is not installed");
  return resolver;
}
