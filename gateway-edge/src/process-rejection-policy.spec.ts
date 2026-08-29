import { describe, expect, it, vi } from "vitest";

import { handleGatewayEdgeUnhandledRejection } from "./process-rejection-policy.js";

function missingAdcError(): Error {
  const error = new Error(
    "Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.",
  );
  error.stack = `${error.name}: ${error.message}\n` +
    "    at GoogleAuth.getApplicationDefaultAsync (/gateway-edge/node_modules/google-auth-library/build/src/auth/googleauth.js:285:15)\n" +
    "    at async GrpcClient.createStub (/gateway-edge/node_modules/google-gax/build/src/grpc.js:373:23)";
  return error;
}

describe("gateway-edge unhandled rejection policy", () => {
  it("contains and reports the known missing-ADC rejection", () => {
    const log = vi.fn();
    const error = missingAdcError();

    expect(() => handleGatewayEdgeUnhandledRejection(error, log)).not.toThrow();
    expect(log).toHaveBeenCalledWith(error);
  });

  it("keeps unrelated unhandled rejections fatal", () => {
    const log = vi.fn();
    const error = new Error("state invariant violated");

    expect(() => handleGatewayEdgeUnhandledRejection(error, log)).toThrow(error);
    expect(log).not.toHaveBeenCalled();
  });

  it("does not contain a lookalike error outside google-auth-library", () => {
    const log = vi.fn();
    const error = missingAdcError();
    error.stack = `${error.name}: ${error.message}\n    at applicationCode (/gateway-edge/dist/index.js:1:1)`;

    expect(() => handleGatewayEdgeUnhandledRejection(error, log)).toThrow(error);
    expect(log).not.toHaveBeenCalled();
  });
});
