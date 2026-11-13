import { describe, expect, it, vi, type Mock } from "vitest";
import { installWebAuthnProxy, webAuthnPageScriptSource, WEBAUTHN_BINDING_NAME, type PageWebAuthnRequest } from "./page-script.js";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const b64 = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("base64url");

type CredentialCall = (options?: Record<string, unknown>) => Promise<unknown>;
interface FakeGlobal extends Record<string, unknown> {
  navigator: { credentials: { get: CredentialCall; create: CredentialCall } };
  DOMException: typeof DOMException;
  PublicKeyCredential?: { prototype: object };
  AuthenticatorAssertionResponse?: { prototype: object };
  AuthenticatorAttestationResponse?: { prototype: object };
}

function fakeGlobal(binding?: (payload: string) => void): { g: FakeGlobal; nativeGet: Mock<CredentialCall>; nativeCreate: Mock<CredentialCall>; sent: PageWebAuthnRequest[] } {
  const sent: PageWebAuthnRequest[] = [];
  const nativeGet = vi.fn<CredentialCall>(async () => "native-get");
  const nativeCreate = vi.fn<CredentialCall>(async () => "native-create");
  const g: FakeGlobal = {
    navigator: { credentials: { get: nativeGet, create: nativeCreate } },
    DOMException,
    PublicKeyCredential: { prototype: { getClientExtensionResults() { throw new Error("native prototype"); } } },
    AuthenticatorAssertionResponse: { prototype: { get signature(): never { throw new Error("native getter"); } } },
    AuthenticatorAttestationResponse: { prototype: { getTransports(): never { throw new Error("native method"); } } },
    [WEBAUTHN_BINDING_NAME]: binding ?? ((payload: string) => sent.push(JSON.parse(payload) as PageWebAuthnRequest)),
  };
  return { g, nativeGet, nativeCreate, sent };
}

function deliver(g: FakeGlobal, seq: number, response: unknown): void {
  (g[`${WEBAUTHN_BINDING_NAME}$deliver`] as (seq: number, response: unknown) => void)(seq, response);
}

describe("webauthn page script", () => {
  it("captures and hides the binding, leaving password and federated credentials to the native implementation", async () => {
    const { g, nativeGet, nativeCreate, sent } = fakeGlobal();
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    expect(g[WEBAUTHN_BINDING_NAME]).toBeUndefined();
    expect(Object.keys(g)).not.toContain(`${WEBAUTHN_BINDING_NAME}$deliver`);
    await expect(g.navigator.credentials.get({ password: true })).resolves.toBe("native-get");
    await expect(g.navigator.credentials.create({ federated: { providers: [] } })).resolves.toBe("native-create");
    expect(nativeGet).toHaveBeenCalledWith({ password: true });
    expect(nativeCreate).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("serializes a get request with buffers as base64url and rebuilds a PublicKeyCredential-shaped assertion from the answer", async () => {
    const { g, sent, nativeGet } = fakeGlobal();
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    const signal = new AbortController().signal;
    const pending = g.navigator.credentials.get({
      mediation: "optional",
      signal,
      publicKey: { challenge: bytes(1, 2, 3), rpId: "example.com", timeout: 60000, allowCredentials: [{ type: "public-key", id: new Uint8Array([4, 5, 6]), transports: ["internal"] }], extensions: { prf: { eval: { first: bytes(7) } } } },
    }) as Promise<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      seq: 1,
      kind: "get",
      mediation: "optional",
      options: { challenge: "AQID", rpId: "example.com", timeout: 60000, allowCredentials: [{ type: "public-key", id: "BAUG", transports: ["internal"] }], extensions: { prf: { eval: { first: "Bw" } } } },
    });
    expect(nativeGet).not.toHaveBeenCalled();
    const clientData = b64(new TextEncoder().encode('{"type":"webauthn.get"}').buffer as ArrayBuffer);
    deliver(g, 1, {
      ok: true,
      credential: {
        id: "BAUG", rawId: "BAUG", type: "public-key", authenticatorAttachment: "platform",
        response: { clientDataJSON: clientData, authenticatorData: "CQ", signature: "Cgs", userHandle: "DA" },
        clientExtensionResults: { prf: { results: { first: "DQ" } } },
      },
    });
    const credential = await pending;
    expect(credential.id).toBe("BAUG");
    expect(credential.type).toBe("public-key");
    expect(credential.authenticatorAttachment).toBe("platform");
    expect(Array.from(new Uint8Array(credential.rawId as ArrayBuffer))).toEqual([4, 5, 6]);
    const response = credential.response as Record<string, ArrayBuffer | null>;
    expect(new TextDecoder().decode(response.clientDataJSON!)).toBe('{"type":"webauthn.get"}');
    expect(Array.from(new Uint8Array(response.authenticatorData!))).toEqual([9]);
    expect(Array.from(new Uint8Array(response.signature!))).toEqual([10, 11]);
    expect(Array.from(new Uint8Array(response.userHandle!))).toEqual([12]);
    const extensions = (credential.getClientExtensionResults as () => { prf: { results: { first: ArrayBuffer } } })();
    expect(Array.from(new Uint8Array(extensions.prf.results.first))).toEqual([13]);
    expect((credential.toJSON as () => { id: string })().id).toBe("BAUG");
    expect(Object.getPrototypeOf(credential)).toBe(g.PublicKeyCredential!.prototype);
    expect(Object.getPrototypeOf(credential.response)).toBe(g.AuthenticatorAssertionResponse!.prototype);
  });

  it("serializes a create request and rebuilds an attestation with the response getters", async () => {
    const { g, sent } = fakeGlobal();
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    const pending = g.navigator.credentials.create({
      publicKey: { challenge: bytes(1), rp: { id: "example.com", name: "Example" }, user: { id: bytes(2), name: "b", displayName: "B" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [{ type: "public-key", id: bytes(3) }], attestation: "none" },
    }) as Promise<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({ seq: 1, kind: "create", options: { challenge: "AQ", user: { id: "Ag", name: "b", displayName: "B" }, excludeCredentials: [{ type: "public-key", id: "Aw" }], attestation: "none" } });
    deliver(g, 1, {
      ok: true,
      credential: {
        id: "Aw", rawId: "Aw", type: "public-key", authenticatorAttachment: "cross-platform",
        response: { clientDataJSON: "e30", attestationObject: "BA", authenticatorData: "BQ", transports: ["usb", "nfc"], publicKey: "Bg", publicKeyAlgorithm: -7 },
        clientExtensionResults: { credProps: { rk: true } },
      },
    });
    const credential = await pending;
    const response = credential.response as Record<string, unknown>;
    expect(Array.from(new Uint8Array(response.attestationObject as ArrayBuffer))).toEqual([4]);
    expect(Array.from(new Uint8Array((response.getAuthenticatorData as () => ArrayBuffer)()))).toEqual([5]);
    expect(Array.from(new Uint8Array((response.getPublicKey as () => ArrayBuffer)()))).toEqual([6]);
    expect((response.getPublicKeyAlgorithm as () => number)()).toBe(-7);
    expect((response.getTransports as () => string[])()).toEqual(["usb", "nfc"]);
    expect(Object.getPrototypeOf(response)).toBe(g.AuthenticatorAttestationResponse!.prototype);
    expect((credential.getClientExtensionResults as () => unknown)()).toEqual({ credProps: { rk: true } });
  });

  it("rejects with the desktop's DOMException and refuses conditional mediation locally", async () => {
    const { g, sent } = fakeGlobal();
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    const pending = g.navigator.credentials.get({ publicKey: { challenge: bytes(1) } });
    deliver(g, 1, { ok: false, error: { name: "NotAllowedError", message: "cancelled" } });
    await expect(pending).rejects.toMatchObject({ name: "NotAllowedError", message: "cancelled" });
    await expect(g.navigator.credentials.get({ mediation: "conditional", publicKey: { challenge: bytes(1) } })).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(sent).toHaveLength(1);
  });

  it("fails like a cancelled prompt when the binding throws or the signal is already aborted", async () => {
    const { g } = fakeGlobal(() => { throw new Error("binding gone"); });
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    await expect(g.navigator.credentials.get({ publicKey: { challenge: bytes(1) } })).rejects.toMatchObject({ name: "NotAllowedError" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(g.navigator.credentials.get({ signal: aborted.signal, publicKey: { challenge: bytes(1) } })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("answers platform-authenticator availability from the gateway, defaulting to unavailable when it does not answer", async () => {
    vi.useFakeTimers();
    try {
      const { g, sent } = fakeGlobal();
      const PublicKeyCredential = g.PublicKeyCredential as Record<string, unknown>;
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
      PublicKeyCredential.isConditionalMediationAvailable = async () => true;
      installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
      const check = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable as () => Promise<boolean>;
      const answered = check();
      expect(sent.at(-1)).toEqual({ seq: 1, query: "platform" });
      deliver(g, 1, { available: true });
      await expect(answered).resolves.toBe(true);
      const silent = check();
      vi.advanceTimersByTime(5_001);
      await expect(silent).resolves.toBe(false);
      await expect((PublicKeyCredential.isConditionalMediationAvailable as () => Promise<boolean>)()).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the gateway when the site aborts an in-flight request, and rejects it as aborted", async () => {
    const { g, sent } = fakeGlobal();
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    const controller = new AbortController();
    const pending = g.navigator.credentials.get({ signal: controller.signal, publicKey: { challenge: bytes(1) } });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sent.at(-1)).toEqual({ seq: 1, cancel: true });
  });

  it("fails requests still waiting on a previous install when the script is reinstalled after a reconnect", async () => {
    const { g } = fakeGlobal();
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    const orphaned = g.navigator.credentials.get({ publicKey: { challenge: bytes(1) } });
    g[WEBAUTHN_BINDING_NAME] = () => {};
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    await expect(orphaned).rejects.toMatchObject({ name: "NotAllowedError" });
  });

  it("does nothing when the binding is missing, is idempotent once installed, and re-routes to a fresh binding after a reconnect without stacking proxies", async () => {
    const { g, nativeGet } = fakeGlobal();
    delete g[WEBAUTHN_BINDING_NAME];
    installWebAuthnProxy(g, WEBAUTHN_BINDING_NAME);
    expect(g.navigator.credentials.get).toBe(nativeGet);

    const second = fakeGlobal();
    installWebAuthnProxy(second.g, WEBAUTHN_BINDING_NAME);
    const proxied = second.g.navigator.credentials.get;
    installWebAuthnProxy(second.g, WEBAUTHN_BINDING_NAME);
    expect(second.g.navigator.credentials.get).toBe(proxied);

    const fresh: PageWebAuthnRequest[] = [];
    second.g[WEBAUTHN_BINDING_NAME] = (payload: string) => fresh.push(JSON.parse(payload) as PageWebAuthnRequest);
    installWebAuthnProxy(second.g, WEBAUTHN_BINDING_NAME);
    void second.g.navigator.credentials.get({ publicKey: { challenge: bytes(1) } });
    expect(fresh).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
    await expect(second.g.navigator.credentials.get({ password: true })).resolves.toBe("native-get");
    expect(second.nativeGet).toHaveBeenCalledTimes(1);
  });

  it("ships as a self-contained source string that installs when evaluated against a page global", async () => {
    const { g, sent } = fakeGlobal();
    const source = webAuthnPageScriptSource(WEBAUTHN_BINDING_NAME);
    expect(source).not.toMatch(/\bimport\b|\brequire\(/u);
    new Function("globalThis", source)(g);
    void g.navigator.credentials.get({ publicKey: { challenge: bytes(9) } });
    expect(sent[0]).toMatchObject({ kind: "get", options: { challenge: "CQ" } });
  });
});
