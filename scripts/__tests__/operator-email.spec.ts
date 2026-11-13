import { describe, expect, it } from "vitest";
import { requireOperatorEmail } from "../lib/operator-email.js";

describe("requireOperatorEmail", () => {
  it("returns the configured operator email, trimmed", () => {
    expect(requireOperatorEmail({ OPERATOR_EMAIL: " ops@example.com " })).toBe("ops@example.com");
  });

  it.each([{}, { OPERATOR_EMAIL: "" }, { OPERATOR_EMAIL: "   " }])(
    "fails loud instead of defaulting to anyone when it is missing: %o",
    (env) => {
      expect(() => requireOperatorEmail(env)).toThrow(
        /OPERATOR_EMAIL must name the operator's admin account/,
      );
    },
  );
});
