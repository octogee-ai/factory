import { rateLimit } from "express-rate-limit";

export function brokerRequestLimit(limit: number, scope: "gateway" | "user" = "gateway") {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: req => !req.boundTenant || (scope === "user" && !req.uid),
    keyGenerator: req => {
      const tenant = req.boundTenant!;
      const identity = tenant.kind === "gateway" ? [tenant.kind, tenant.gatewayId] : [tenant.kind, tenant.actor];
      return JSON.stringify(scope === "user" ? [...identity, req.uid] : identity);
    },
    message: { error: "rate_limited" },
  });
}
