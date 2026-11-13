export const ADMIN_API_CAPABILITIES_HEADER = "Admin-Api-Capabilities";
export const ADMIN_API_DRY_RUN_CAPABILITY = "dry-run";
export class AdminDryRunPlanned extends Error {
    plan;
    constructor(intent) {
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
export function isAdminDryRun(req) {
    return req.query.dryRun === "true";
}
export function adminDryRunBody(plans, context = {}) {
    return { dryRun: true, plans, ...context };
}
export function admitAdminDryRunMarker(req, res, next) {
    res.set(ADMIN_API_CAPABILITIES_HEADER, ADMIN_API_DRY_RUN_CAPABILITY);
    const marker = req.query.dryRun;
    if (marker !== undefined && marker !== "true" && marker !== "false") {
        res.status(400).json({ error: "dryRun must be true or false" });
        return;
    }
    next();
}
export function refuseUnansweredAdminDryRun(req, res, next) {
    if (!isAdminDryRun(req) || req.method === "GET" || req.method === "HEAD") {
        next();
        return;
    }
    res.status(400).json({ error: "this route does not answer dry runs" });
}
export function respondToAdminDryRun(error, res) {
    if (!(error instanceof AdminDryRunPlanned))
        return false;
    res.status(200).json(adminDryRunBody([error.plan]));
    return true;
}
