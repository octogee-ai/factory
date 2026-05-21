// gateway-edge Firestore collection names used in emulator specs.
// Kept package-local because these are gateway-edge-domain — the
// shared test helper at @shared/test-helpers/firestore-emulator
// deliberately does not export collection names (each package owns its
// own). Chat-proxy mirrors this pattern in its own helper.
export const TICKETS_COLLECTION = "builderShellTickets";
export const SESSIONS_COLLECTION = "builder_shell_sessions";
export const GATEWAYS_COLLECTION = "glmGateways";
