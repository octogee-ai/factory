export type TerraformPlanAction = "no-op" | "read" | "create" | "update" | "delete";

export interface TerraformPlan {
  format_version?: string;
  terraform_version?: string;
  complete?: boolean;
  errored?: boolean;
  deferred_changes?: unknown;
  checks?: Array<{ status?: string }>;
  resource_changes?: Array<{
    address: string;
    type?: string;
    change?: {
      actions?: TerraformPlanAction[];
      before?: unknown;
      after?: unknown;
      before_unknown?: unknown;
      after_unknown?: unknown;
      before_sensitive?: unknown;
      after_sensitive?: unknown;
      replace_paths?: unknown;
      importing?: unknown;
      generated_config?: unknown;
    };
  }>;
  resource_drift?: TerraformPlan["resource_changes"];
  output_changes?: Record<string, { actions?: TerraformPlanAction[] }>;
}

export interface TerraformPlanReceiptOptions {
  target: string;
  phase: string;
  generatedAt: string;
  gitCommit: string;
  allowedDestructiveAddresses: Set<string>;
  allowedChangeAddresses?: Set<string> | null;
  preReleaseConvergence?: boolean;
}

export interface TerraformPlanReceipt {
  schemaVersion: 1 | 2;
  target: string;
  phase: string;
  generatedAt: string;
  gitCommit: string;
  terraformVersion?: string;
  planFormatVersion?: string;
  planSha256: string;
  summary: Record<"create" | "update" | "delete" | "replace", number>;
  changes: Array<{ address: string; actions: TerraformPlanAction[] }>;
  knownVolatileMetadataExceptions?: Array<{
    source: "resource_drift";
    address:
      | "module.data_project.google_firestore_database.default"
      | "module.iam.google_project_iam_member.cloudsql_client";
    resourceType: "google_firestore_database" | "google_project_iam_member";
    actions: ["update"];
    changedTopLevelPaths: ["etag"];
  }>;
}

export function buildPlanReceipt(
  plan: TerraformPlan,
  options: TerraformPlanReceiptOptions,
): TerraformPlanReceipt;
