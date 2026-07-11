import { describe, expect, it } from "vitest";

import {
  parseCaptureArgs,
  userByosubIntegrationPatch,
} from "../ops/capture-byosub-credential.js";

describe("capture-byosub-credential", () => {
  it("accepts only owner-scoped capture arguments", () => {
    expect(
      parseCaptureArgs([
        "--env=test",
        "--provider=openai",
        "--uid=uid-1",
        "--file=/tmp/auth.json",
      ]),
    ).toEqual({ env: "test", provider: "openai", uid: "uid-1", file: "/tmp/auth.json" });
    expect(() =>
      parseCaptureArgs([
        "--env=test",
        "--gateway=default-r7",
        "--provider=openai",
        "--uid=uid-1",
        "--file=/tmp/auth.json",
      ]),
    ).toThrow(/Unknown arg/);
  });

  it("writes only the user integration authority, never a gateway credential ref", () => {
    expect(userByosubIntegrationPatch("openai")).toEqual({
      connected: true,
      providers: {
        openai: {
          provider: "openai",
          modelCredentialProvider: "openai-codex",
          status: "connected",
          connected: true,
        },
      },
    });
  });
});
