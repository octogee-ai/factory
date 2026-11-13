import { describe, expect, it } from "vitest";
import { decodePasskeyMessage, encodePasskeyMessage, WEBAUTHN_MAX_PAYLOAD_BYTES, type PasskeyLinkMessage, type WebAuthnRequest } from "./protocol.js";

const request: WebAuthnRequest = { origin: "https://login.example", rpId: "login.example", kind: "get", options: { challenge: "AQID", allowCredentials: [] } };

describe("passkey link messages", () => {
  it("round-trips requests and answers as bounded json", () => {
    const messages: PasskeyLinkMessage[] = [
      { type: "request", id: 3, request },
      { type: "request", id: 4, request: { ...request, kind: "create", options: { challenge: "AQID", rp: { id: "login.example", name: "Example" }, user: { id: "Cg", name: "b", displayName: "B" }, pubKeyCredParams: [] } } },
      { type: "response", id: 3, response: { ok: true, credential: { id: "BAUG", rawId: "BAUG", type: "public-key", response: { clientDataJSON: "e30" }, clientExtensionResults: {} } } },
      { type: "response", id: 4, response: { ok: false, error: { name: "NotAllowedError", message: "The operation either timed out or was not allowed." } } },
      { type: "cancel", id: 4 },
      { type: "hello", platformAuthenticator: true },
    ];
    for (const message of messages) expect(decodePasskeyMessage(encodePasskeyMessage(message))).toEqual(message);
  });

  it("refuses messages that are oversized, malformed or carry the wrong shape", () => {
    expect(() => encodePasskeyMessage({ type: "request", id: 1, request: { ...request, options: { challenge: "x".repeat(WEBAUTHN_MAX_PAYLOAD_BYTES + 1024) } } })).toThrow("too large");
    expect(() => encodePasskeyMessage({ type: "request", id: 1, request: { ...request, origin: "" } })).toThrow();
    expect(() => encodePasskeyMessage({ type: "request", id: 0, request })).toThrow();
    expect(() => encodePasskeyMessage({ type: "request", id: 1, request: { ...request, kind: "list" as "get" } })).toThrow();
    expect(() => encodePasskeyMessage({ type: "response", id: 1, response: { ok: false, error: { name: "", message: "x" } } })).toThrow();
    expect(() => decodePasskeyMessage("not json")).toThrow("not json");
    expect(() => decodePasskeyMessage(JSON.stringify({ type: "hello", id: 1 }))).toThrow("invalid");
    expect(() => decodePasskeyMessage(JSON.stringify({ type: "hello", platformAuthenticator: "yes" }))).toThrow("invalid");
    expect(() => decodePasskeyMessage(JSON.stringify({ type: "cancel", id: 0 }))).toThrow("invalid");
    expect(() => decodePasskeyMessage(JSON.stringify({ type: "request", id: 1.5, request }))).toThrow("invalid");
  });
});
