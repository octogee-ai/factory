export const WEBAUTHN_MAX_PAYLOAD_BYTES = 64 * 1024;
export const WEBAUTHN_TIMEOUT_MS = 120_000;
export const WEBAUTHN_ORIGIN_MAX_LENGTH = 1024;
export const WEBAUTHN_RP_ID_MAX_LENGTH = 253;
export const WEBAUTHN_ERROR_NAME_MAX_LENGTH = 64;
export const WEBAUTHN_ERROR_MESSAGE_MAX_LENGTH = 500;
export const PASSKEY_LINK_MAX_MESSAGE_BYTES = WEBAUTHN_MAX_PAYLOAD_BYTES + 1024;
export const PASSKEY_CLOSE_REPLACED = 4002;

export type WebAuthnKind = "get" | "create";
export interface WebAuthnRequest {
  origin: string;
  rpId: string;
  kind: WebAuthnKind;
  options: Record<string, unknown>;
}
export interface WebAuthnFailure { name: string; message: string }
export type WebAuthnResponse =
  | { ok: true; credential: Record<string, unknown> }
  | { ok: false; error: WebAuthnFailure };

export type PasskeyLinkMessage =
  | { type: "request"; id: number; request: WebAuthnRequest }
  | { type: "response"; id: number; response: WebAuthnResponse }
  | { type: "cancel"; id: number }
  | { type: "hello"; platformAuthenticator: boolean };

export class PasskeyLinkProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "PasskeyLinkProtocolError"; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export function isWebAuthnRequest(value: unknown): value is WebAuthnRequest {
  if (!isPlainObject(value)) return false;
  return isBoundedString(value.origin, WEBAUTHN_ORIGIN_MAX_LENGTH)
    && isBoundedString(value.rpId, WEBAUTHN_RP_ID_MAX_LENGTH)
    && (value.kind === "get" || value.kind === "create")
    && isPlainObject(value.options);
}

export function isWebAuthnFailure(value: unknown): value is WebAuthnFailure {
  return isPlainObject(value) && isBoundedString(value.name, WEBAUTHN_ERROR_NAME_MAX_LENGTH) && typeof value.message === "string" && value.message.length <= WEBAUTHN_ERROR_MESSAGE_MAX_LENGTH;
}

export function isWebAuthnResponse(value: unknown): value is WebAuthnResponse {
  if (!isPlainObject(value)) return false;
  if (value.ok === true) return isPlainObject(value.credential);
  return value.ok === false && isWebAuthnFailure(value.error);
}

export function webAuthnFailure(name: string, message: string): WebAuthnResponse {
  return { ok: false, error: { name: name.slice(0, WEBAUTHN_ERROR_NAME_MAX_LENGTH), message: message.slice(0, WEBAUTHN_ERROR_MESSAGE_MAX_LENGTH) } };
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function isMessageId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffffffff;
}

function isPasskeyLinkMessage(value: unknown): value is PasskeyLinkMessage {
  if (!isPlainObject(value)) return false;
  if (value.type === "hello") return typeof value.platformAuthenticator === "boolean";
  if (!isMessageId(value.id)) return false;
  if (value.type === "request") return isWebAuthnRequest(value.request);
  if (value.type === "cancel") return true;
  return value.type === "response" && isWebAuthnResponse(value.response);
}

export function encodePasskeyMessage(message: PasskeyLinkMessage): string {
  if (!isPasskeyLinkMessage(message)) throw new PasskeyLinkProtocolError("invalid passkey message");
  const text = JSON.stringify(message);
  if (byteLength(text) > PASSKEY_LINK_MAX_MESSAGE_BYTES) throw new PasskeyLinkProtocolError("passkey message too large");
  return text;
}

export function decodePasskeyMessage(text: string): PasskeyLinkMessage {
  if (byteLength(text) > PASSKEY_LINK_MAX_MESSAGE_BYTES) throw new PasskeyLinkProtocolError("passkey message too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new PasskeyLinkProtocolError("passkey message is not json"); }
  if (!isPasskeyLinkMessage(value)) throw new PasskeyLinkProtocolError("invalid passkey message");
  return value;
}
