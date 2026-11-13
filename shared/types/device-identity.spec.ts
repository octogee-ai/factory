import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDeviceAuthPayloadV3,
  generateIdentity,
  publicKeyRawBase64UrlFromPem,
  signConnectDevice,
} from "./device-identity.js";

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((value.length + 3) % 4),
    "base64",
  );
}

describe("generateIdentity", () => {
  it("returns Ed25519 PEM keys with a sha256 device id", () => {
    const identity = generateIdentity();

    expect(identity.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(identity.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it("derives distinct device ids from distinct keypairs", () => {
    expect(generateIdentity().deviceId).not.toBe(generateIdentity().deviceId);
  });
});

describe("buildDeviceAuthPayloadV3", () => {
  it("builds the canonical v3 payload with normalized device metadata", () => {
    expect(
      buildDeviceAuthPayloadV3({
        deviceId: "dev",
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        scopes: ["operator.admin"],
        signedAtMs: 1234,
        token: "tok",
        nonce: "n1",
        platform: "  Linux  ",
        deviceFamily: "  Pod  ",
      }),
    ).toBe("v3|dev|gateway-client|backend|operator|operator.admin|1234|tok|n1|linux|pod");
  });

  it("keeps optional token and metadata as empty payload segments", () => {
    expect(
      buildDeviceAuthPayloadV3({
        deviceId: "d",
        clientId: "c",
        clientMode: "m",
        role: "r",
        scopes: [],
        signedAtMs: 0,
        nonce: "n",
      }),
    ).toBe("v3|d|c|m|r||0||n||");
  });
});

describe("signConnectDevice", () => {
  it("returns a public frame with a verifiable Ed25519 signature", () => {
    const identity = generateIdentity();
    const signed = signConnectDevice({
      identity,
      clientId: "gateway-client",
      clientMode: "backend",
      role: "operator",
      scopes: ["operator.admin"],
      nonce: "nonce-abc",
      token: "tok",
      platform: "linux",
      signedAtMs: 1000,
    });
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: "gateway-client",
      clientMode: "backend",
      role: "operator",
      scopes: ["operator.admin"],
      signedAtMs: 1000,
      token: "tok",
      nonce: "nonce-abc",
      platform: "linux",
      deviceFamily: null,
    });

    expect(signed).toMatchObject({
      id: identity.deviceId,
      nonce: "nonce-abc",
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    });
    expect(
      crypto.verify(
        null,
        Buffer.from(payload, "utf8"),
        crypto.createPublicKey(identity.publicKeyPem),
        base64UrlDecode(signed.signature),
      ),
    ).toBe(true);
  });
});
