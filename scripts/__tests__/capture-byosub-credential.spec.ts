import { describe, it, expect } from "vitest";
import {
  parseCaptureArgs,
  secretNameFor,
  validateCredentialPayload,
} from "../ops/capture-byosub-credential.js";

const ok = [
  "--env=prod",
  "--gateway=gw-bender",
  "--agent=octogee-ceckert-coach",
  "--provider=openai",
  "--uid=Abc123Uid",
  "--file=/tmp/auth.json",
];

describe("parseCaptureArgs", () => {
  it("parses a valid invocation", () => {
    expect(parseCaptureArgs(ok)).toEqual({
      env: "prod",
      gateway: "gw-bender",
      agent: "octogee-ceckert-coach",
      provider: "openai",
      uid: "Abc123Uid",
      file: "/tmp/auth.json",
    });
  });

  it("rejects missing/invalid --env", () => {
    expect(() => parseCaptureArgs(ok.filter((a) => !a.startsWith("--env")))).toThrow(/--env/);
    expect(() =>
      parseCaptureArgs(ok.map((a) => (a.startsWith("--env") ? "--env=stage" : a))),
    ).toThrow(/--env/);
  });

  it("rejects an unsafe --gateway / --agent (filesystem + secret-id safety)", () => {
    expect(() =>
      parseCaptureArgs(ok.map((a) => (a.startsWith("--gateway") ? "--gateway=GW/Bender" : a))),
    ).toThrow(/gateway/i);
    expect(() =>
      parseCaptureArgs(ok.map((a) => (a.startsWith("--agent") ? "--agent=../etc" : a))),
    ).toThrow(/agent/i);
  });

  it("defers --provider=anthropic to Chunk E; rejects unknown providers", () => {
    expect(() =>
      parseCaptureArgs(ok.map((a) => (a.startsWith("--provider") ? "--provider=anthropic" : a))),
    ).toThrow(/anthropic|Chunk E/i);
    expect(() =>
      parseCaptureArgs(ok.map((a) => (a.startsWith("--provider") ? "--provider=grok" : a))),
    ).toThrow(/provider/i);
  });

  it("rejects missing/unsafe --uid and missing --file", () => {
    expect(() => parseCaptureArgs(ok.filter((a) => !a.startsWith("--uid")))).toThrow(/uid/i);
    expect(() =>
      parseCaptureArgs(ok.map((a) => (a.startsWith("--uid") ? "--uid=a/b c" : a))),
    ).toThrow(/uid/i);
    expect(() => parseCaptureArgs(ok.filter((a) => !a.startsWith("--file")))).toThrow(/--file/);
  });
});

describe("secretNameFor", () => {
  it("is owner-scoped and provider-suffixed", () => {
    expect(secretNameFor("Abc123Uid", "openai")).toBe("byosub-Abc123Uid-openai");
  });
});

describe("validateCredentialPayload", () => {
  it("accepts a plausible codex auth.json", () => {
    expect(
      validateCredentialPayload(
        "openai",
        '{"auth_mode":"chatgpt","tokens":{"refresh_token":"r"}}',
      ).ok,
    ).toBe(true);
    expect(validateCredentialPayload("openai", '{"tokens":{"refresh_token":"r"}}').ok).toBe(true);
  });

  it("rejects empty / non-JSON / structurally-wrong payloads (no junk in Secret Manager)", () => {
    expect(validateCredentialPayload("openai", "").ok).toBe(false);
    expect(validateCredentialPayload("openai", "not json").ok).toBe(false);
    expect(validateCredentialPayload("openai", '{"hello":1}').ok).toBe(false);
    
    expect(validateCredentialPayload("openai", '{"auth_mode":"chatgpt"}').ok).toBe(false);
    expect(validateCredentialPayload("openai", '{"tokens":"notobj"}').ok).toBe(false);
  });
});
