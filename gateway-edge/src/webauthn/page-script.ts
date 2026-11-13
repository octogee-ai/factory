export const WEBAUTHN_BINDING_NAME = "__octogeeWebAuthn";

export interface PageWebAuthnRequest {
  seq: number;
  kind: "get" | "create";
  mediation?: string;
  options: Record<string, unknown>;
}

type AnyRecord = Record<string, unknown>;
type Credentials = { get: (options?: AnyRecord) => Promise<unknown>; create: (options?: AnyRecord) => Promise<unknown> };

export function installWebAuthnProxy(globalObj: AnyRecord, bindingName: string): void {
  const binding = globalObj[bindingName] as ((payload: string) => void) | undefined;
  if (typeof binding !== "function") return;
  delete globalObj[bindingName];
  const navigatorObj = globalObj.navigator as { credentials?: Credentials } | undefined;
  const credentials = navigatorObj && navigatorObj.credentials;
  if (!credentials || typeof credentials.get !== "function" || typeof credentials.create !== "function") return;

  const nativeKey = bindingName + "$native";
  const deliverKey = bindingName + "$deliver";
  const stored = (credentials as unknown as AnyRecord)[nativeKey] as Credentials | undefined;
  const native: Credentials = stored || { get: credentials.get.bind(credentials), create: credentials.create.bind(credentials) };
  if (!stored) Object.defineProperty(credentials, nativeKey, { value: native, enumerable: false, configurable: false, writable: false });

  const maxChars = 60000;
  const pending = new Map<number, { kind: "get" | "create"; resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  let seq = 0;
  const abandonKey = bindingName + "$abandon";
  const queries = new Map<number, (available: boolean) => void>();

  const fail = (name: string, message: string): Error => {
    const DomException = globalObj.DOMException as (new (message: string, name: string) => Error) | undefined;
    if (typeof DomException === "function") return new DomException(message, name);
    const error = new Error(message);
    error.name = name;
    return error;
  };

  const toBase64Url = (value: ArrayBuffer | ArrayBufferView): string => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
    let encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
    while (encoded.endsWith("=")) encoded = encoded.slice(0, -1);
    return encoded;
  };
  const fromBase64Url = (value: unknown): ArrayBuffer => {
    if (typeof value !== "string") throw new Error("expected base64url");
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };
  const optionalBuffer = (value: unknown): ArrayBuffer | null => (value === undefined || value === null ? null : fromBase64Url(value));

  const encode = (value: unknown): unknown => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return toBase64Url(value as ArrayBuffer);
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object") {
      const out: AnyRecord = {};
      for (const key of Object.keys(value as AnyRecord)) {
        const entry = (value as AnyRecord)[key];
        if (entry !== undefined && typeof entry !== "function") out[key] = encode(entry);
      }
      return out;
    }
    return value;
  };

  const decodeExtensions = (results: AnyRecord): AnyRecord => {
    const out: AnyRecord = {};
    for (const key of Object.keys(results)) out[key] = results[key];
    const prf = results.prf as { results?: AnyRecord } | undefined;
    if (prf && prf.results && typeof prf.results === "object") {
      const decoded: AnyRecord = {};
      if (prf.results.first !== undefined) decoded.first = fromBase64Url(prf.results.first);
      if (prf.results.second !== undefined) decoded.second = fromBase64Url(prf.results.second);
      out.prf = Object.assign({}, prf, { results: decoded });
    }
    const largeBlob = results.largeBlob as AnyRecord | undefined;
    if (largeBlob && typeof largeBlob.blob === "string") out.largeBlob = Object.assign({}, largeBlob, { blob: fromBase64Url(largeBlob.blob) });
    return out;
  };

  const build = (kind: "get" | "create", json: AnyRecord): AnyRecord => {
    const raw = (json.response || {}) as AnyRecord;
    const response: AnyRecord = { clientDataJSON: fromBase64Url(raw.clientDataJSON) };
    if (kind === "get") {
      response.authenticatorData = fromBase64Url(raw.authenticatorData);
      response.signature = fromBase64Url(raw.signature);
      response.userHandle = optionalBuffer(raw.userHandle);
    } else {
      const attestationObject = fromBase64Url(raw.attestationObject);
      const authenticatorData = optionalBuffer(raw.authenticatorData);
      const publicKey = optionalBuffer(raw.publicKey);
      const transports = Array.isArray(raw.transports) ? (raw.transports as string[]).slice() : [];
      response.attestationObject = attestationObject;
      response.getAuthenticatorData = () => authenticatorData;
      response.getPublicKey = () => publicKey;
      response.getPublicKeyAlgorithm = () => raw.publicKeyAlgorithm;
      response.getTransports = () => transports.slice();
    }
    const ResponseType = globalObj[kind === "get" ? "AuthenticatorAssertionResponse" : "AuthenticatorAttestationResponse"] as { prototype?: object } | undefined;
    if (ResponseType && ResponseType.prototype) Object.setPrototypeOf(response, ResponseType.prototype);
    const extensions = (json.clientExtensionResults || {}) as AnyRecord;
    const credential: AnyRecord = {
      id: json.id,
      rawId: fromBase64Url(json.rawId),
      type: typeof json.type === "string" ? json.type : "public-key",
      authenticatorAttachment: typeof json.authenticatorAttachment === "string" ? json.authenticatorAttachment : null,
      response,
      getClientExtensionResults: () => decodeExtensions(extensions),
      toJSON: () => json,
    };
    const PublicKeyCredential = globalObj.PublicKeyCredential as { prototype?: object } | undefined;
    if (PublicKeyCredential && PublicKeyCredential.prototype) Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
    return credential;
  };

  const deliver = (id: number, response: unknown): void => {
    const query = queries.get(id);
    if (query) {
      queries.delete(id);
      query(Boolean(response && (response as { available?: unknown }).available === true));
      return;
    }
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const answer = (response || {}) as { ok?: boolean; credential?: AnyRecord; error?: { name?: string; message?: string } };
    if (answer.ok === true && answer.credential && typeof answer.credential === "object") {
      try { entry.resolve(build(entry.kind, answer.credential)); } catch { entry.reject(fail("NotAllowedError", "The desktop returned an unreadable passkey response.")); }
      return;
    }
    const error = answer.error || {};
    entry.reject(fail(typeof error.name === "string" && error.name ? error.name : "NotAllowedError", typeof error.message === "string" ? error.message : "The operation either timed out or was not allowed."));
  };
  Object.defineProperty(globalObj, deliverKey, { value: deliver, enumerable: false, configurable: true, writable: false });

  const previousAbandon = globalObj[abandonKey];
  if (typeof previousAbandon === "function") (previousAbandon as () => void)();
  const abandon = () => {
    for (const entry of pending.values()) entry.reject(fail("NotAllowedError", "The passkey request was interrupted; try again."));
    pending.clear();
    for (const query of queries.values()) query(false);
    queries.clear();
  };
  Object.defineProperty(globalObj, abandonKey, { value: abandon, enumerable: false, configurable: true, writable: false });

  const send = (payload: string): boolean => {
    try {
      binding(payload);
      return true;
    } catch {
      return false;
    }
  };

  const proxied = (kind: "get" | "create", options?: AnyRecord): Promise<unknown> => {
    if (!options || typeof options !== "object" || !options.publicKey || typeof options.publicKey !== "object") return native[kind](options);
    const signal = options.signal as { aborted?: boolean; addEventListener?: (type: string, listener: () => void) => void } | undefined;
    if (signal && signal.aborted) return Promise.reject(fail("AbortError", "The operation was aborted."));
    if (options.mediation === "conditional") return Promise.reject(fail("NotSupportedError", "Conditional passkey mediation is not available on this computer."));
    return new Promise((resolve, reject) => {
      seq += 1;
      const id = seq;
      const request: PageWebAuthnRequest = { seq: id, kind, options: encode(options.publicKey) as AnyRecord };
      if (typeof options.mediation === "string") request.mediation = options.mediation;
      const payload = JSON.stringify(request);
      if (payload.length > maxChars) { reject(fail("NotAllowedError", "The passkey request is too large to relay.")); return; }
      pending.set(id, { kind, resolve, reject });
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(fail("AbortError", "The operation was aborted."));
          send(JSON.stringify({ seq: id, cancel: true }));
        });
      }
      if (!send(payload)) {
        pending.delete(id);
        reject(fail("NotAllowedError", "The operation either timed out or was not allowed."));
      }
    });
  };

  const platformAvailable = (): Promise<boolean> => new Promise((resolve) => {
    seq += 1;
    const id = seq;
    const timer = setTimeout(() => { if (queries.delete(id)) resolve(false); }, 5000);
    queries.set(id, (available) => { clearTimeout(timer); resolve(available); });
    if (!send(JSON.stringify({ seq: id, query: "platform" }))) { queries.delete(id); clearTimeout(timer); resolve(false); }
  });
  const publicKeyCredential = globalObj.PublicKeyCredential as AnyRecord | undefined;
  if (publicKeyCredential && (typeof publicKeyCredential === "object" || typeof publicKeyCredential === "function")) {
    publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = platformAvailable;
    publicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  }

  credentials.get = (options?: AnyRecord) => proxied("get", options);
  credentials.create = (options?: AnyRecord) => proxied("create", options);
}

export function webAuthnPageScriptSource(bindingName: string = WEBAUTHN_BINDING_NAME): string {
  return `(${installWebAuthnProxy.toString()})(globalThis, ${JSON.stringify(bindingName)});`;
}

export function webAuthnDeliverName(bindingName: string = WEBAUTHN_BINDING_NAME): string {
  return `${bindingName}$deliver`;
}
