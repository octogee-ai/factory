import {
  USER_VISIBLE_FEATURE_FLAG_KEYS,
  featureFlagBypassedForAdmin,
  type FeatureDecision,
  type FeatureFlagKey,
  type FeaturePolicy as FeaturePolicyContract,
  type FeatureSubject,
} from "@octogee/shared/types/feature-flags";

export interface FeatureFlagProvider {
  evaluate(subject: FeatureSubject, keys: readonly FeatureFlagKey[]): Promise<{
    isEnabled(key: FeatureFlagKey): boolean;
  }>;
}

export interface FeaturePolicyMetrics {
  evaluation(flag: FeatureFlagKey, outcome: "enabled" | "disabled" | "unavailable"): void;
  providerError(reason: "timeout" | "provider_error"): void;
}

export interface FeaturePolicyLogger {
  error(message: string, fields: Record<string, unknown>): void;
}

class FeatureEvaluationTimeout extends Error {
  constructor() {
    super("Feature flag evaluation timed out");
    this.name = "FeatureEvaluationTimeout";
  }
}

function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new FeatureEvaluationTimeout()), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function unavailableReason(error: unknown): "timeout" | "provider_error" {
  return error instanceof FeatureEvaluationTimeout ? "timeout" : "provider_error";
}

export class FeaturePolicy implements FeaturePolicyContract {
  constructor(
    private readonly provider: FeatureFlagProvider,
    private readonly options: {
      timeoutMs?: number;
      metrics?: FeaturePolicyMetrics;
      logger?: FeaturePolicyLogger;
    } = {},
  ) {}

  async evaluate(
    key: FeatureFlagKey,
    subject: FeatureSubject,
    context: string,
  ): Promise<FeatureDecision> {
    const decisions = await this.evaluateMany([key], subject, context);
    return decisions[key];
  }

  async userVisibleDecisions(
    subject: FeatureSubject,
    context: string,
  ): Promise<Record<FeatureFlagKey, FeatureDecision>> {
    return this.evaluateMany(USER_VISIBLE_FEATURE_FLAG_KEYS, subject, context);
  }

  private async evaluateMany(
    keys: readonly FeatureFlagKey[],
    subject: FeatureSubject,
    context: string,
  ): Promise<Record<FeatureFlagKey, FeatureDecision>> {
    const bypassed = keys.filter((key) => featureFlagBypassedForAdmin(key, subject));
    const adminDecisions = bypassed.map((key) => {
      this.options.metrics?.evaluation(key, "enabled");
      return [key, { state: "enabled", value: true } satisfies FeatureDecision] as const;
    });
    const remaining = keys.filter((key) => !featureFlagBypassedForAdmin(key, subject));
    if (remaining.length === 0) {
      return Object.fromEntries(adminDecisions) as Record<FeatureFlagKey, FeatureDecision>;
    }

    try {
      const values = await within(
        this.provider.evaluate(subject, remaining),
        this.options.timeoutMs ?? 2_000,
      );
      return Object.fromEntries([...adminDecisions, ...remaining.map((key) => {
        const decision: FeatureDecision = values.isEnabled(key)
          ? { state: "enabled", value: true }
          : { state: "disabled", value: false };
        this.options.metrics?.evaluation(key, decision.state);
        return [key, decision];
      })]) as Record<FeatureFlagKey, FeatureDecision>;
    } catch (error) {
      const reason = unavailableReason(error);
      this.options.metrics?.providerError(reason);
      this.options.logger?.error("Feature flag evaluation failed", {
        context,
        reason,
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      return Object.fromEntries([...adminDecisions, ...remaining.map((key) => {
        this.options.metrics?.evaluation(key, "unavailable");
        return [key, { state: "unavailable", value: false, reason } satisfies FeatureDecision];
      })]) as Record<FeatureFlagKey, FeatureDecision>;
    }
  }
}

export class DisabledFeatureFlagProvider implements FeatureFlagProvider {
  async evaluate(_subject: FeatureSubject, _keys: readonly FeatureFlagKey[]): Promise<{
    isEnabled(key: FeatureFlagKey): boolean;
  }> {
    return { isEnabled: () => false };
  }
}
