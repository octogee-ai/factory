const MISSING_ADC_MESSAGE = "Could not load the default credentials.";
const GOOGLE_AUTH_LIBRARY_STACK = "/google-auth-library/";

function isMissingApplicationDefaultCredentials(reason: unknown): reason is Error {
  return reason instanceof Error &&
    reason.message.startsWith(MISSING_ADC_MESSAGE) &&
    reason.stack?.includes(GOOGLE_AUTH_LIBRARY_STACK) === true;
}

export function handleGatewayEdgeUnhandledRejection(
  reason: unknown,
  reportMissingCredentials: (error: Error) => void,
): void {
  if (!isMissingApplicationDefaultCredentials(reason)) throw reason;
  reportMissingCredentials(reason);
}

let installed = false;

export function installGatewayEdgeUnhandledRejectionPolicy(
  reportMissingCredentials: (error: Error) => void,
): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    handleGatewayEdgeUnhandledRejection(reason, reportMissingCredentials);
  });
}
