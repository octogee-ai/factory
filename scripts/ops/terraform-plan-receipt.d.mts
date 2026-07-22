export type TerraformPlanAction = "no-op" | "read" | "create" | "update" | "delete";

export interface TerraformPlan {
  format_version?: string;
  terraform_version?: string;
  resource_changes?: Array<{
    address: string;
    change?: {
      actions?: TerraformPlanAction[];
      before?: unknown;
      after?: unknown;
    };
  }>;
}

export interface TerraformPlanReceiptOptions {
  target: string;
  phase: string;
  generatedAt: string;
  gitCommit: string;
  allowedDestructiveAddresses: Set<string>;
  allowedChangeAddresses?: Set<string> | null;
}

export interface TerraformPlanReceipt {
  schemaVersion: 1;
  target: string;
  phase: string;
  generatedAt: string;
  gitCommit: string;
  terraformVersion?: string;
  planFormatVersion?: string;
  planSha256: string;
  summary: Record<"create" | "update" | "delete" | "replace", number>;
  changes: Array<{ address: string; actions: TerraformPlanAction[] }>;
}

export function buildPlanReceipt(
  plan: TerraformPlan,
  options: TerraformPlanReceiptOptions,
): TerraformPlanReceipt;
