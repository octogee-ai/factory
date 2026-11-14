import { installBrokeredUserIdentity } from "./lib/brokered-user-identity-provider.js";
import { gatewayEdgeMode } from "./lib/gateway-edge-mode.js";

if (gatewayEdgeMode() === "sidecar") installBrokeredUserIdentity(process.env);
await import("./index.js");
