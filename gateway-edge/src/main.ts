import { installBrokeredUserIdentity } from "./lib/brokered-user-identity-provider.js";

installBrokeredUserIdentity(process.env);
await import("./index.js");
