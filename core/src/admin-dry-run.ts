import type { NextFunction, Request, Response } from "express";

export const ADMIN_API_CAPABILITIES_HEADER = "Admin-Api-Capabilities";
export const ADMIN_API_DRY_RUN_CAPABILITY = "dry-run";

export interface AdminMutationPlan {
  what: string;
  why: string;
  kind: string | null;
  target: Record<string, unknown>;
  preActionStatus: Record<string, unknown>;
  mutation: Record<string, unknown>;
  forced: boolean;
}

export interface AdminMutationIntent {
  what: string;
  why: string;
  target: Record<string, unknown>;
  preActionStatus: Record<string, unknown>;
  mutation: Record<string, unknown>;
  forced?: boolean;
}

export class AdminDryRunPlanned extends Error {
  readonly plan: AdminMutationPlan;

  constructor(intent: AdminMutationIntent) {
    super(`dry run planned: ${intent.what}`);
    this.name = "AdminDryRunPlanned";
    this.plan = {
      what: intent.what,
      why: intent.why,
      kind: typeof intent.mutation.kind === "string" ? intent.mutation.kind : null,
      target: intent.target,
      preActionStatus: intent.preActionStatus,
      mutation: intent.mutation,
      forced: intent.forced === true,
    };
  }
}

export function isAdminDryRun(req: Request): boolean {
  return req.query.dryRun === "true";
}

export function adminDryRunBody(
  plans: readonly AdminMutationPlan[],
  context: Record<string, unknown> = {},
): Record<string, unknown> {
  return { dryRun: true, plans, ...context };
}

export function admitAdminDryRunMarker(req: Request, res: Response, next: NextFunction): void {
  res.set(ADMIN_API_CAPABILITIES_HEADER, ADMIN_API_DRY_RUN_CAPABILITY);
  const marker = req.query.dryRun;
  if (marker !== undefined && marker !== "true" && marker !== "false") {
    res.status(400).json({ error: "dryRun must be true or false" });
    return;
  }
  next();
}

export function refuseUnansweredAdminDryRun(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminDryRun(req) || req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  res.status(400).json({ error: "this route does not answer dry runs" });
}

export function respondToAdminDryRun(error: unknown, res: Response): boolean {
  if (!(error instanceof AdminDryRunPlanned)) return false;
  res.status(200).json(adminDryRunBody([error.plan]));
  return true;
}
