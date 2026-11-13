export const EGRESS_DATA_CHUNK_BYTES = 64 * 1024;
export const EGRESS_MAX_FRAME_BYTES = EGRESS_DATA_CHUNK_BYTES + 5;
export const EGRESS_HOST_MAX_LENGTH = 255;
export const EGRESS_CLOSE_NOT_SELECTED = 4001;
export const EGRESS_CLOSE_REPLACED = 4002;

export const SOCKS_REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  notAllowedByRuleset: 0x02,
  networkUnreachable: 0x03,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  ttlExpired: 0x06,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08,
} as const;
export type SocksReply = (typeof SOCKS_REPLY)[keyof typeof SOCKS_REPLY];

const FRAME_TYPE = { open: 1, opened: 2, refused: 3, data: 4, close: 5, reset: 6, pause: 7, resume: 8 } as const;
type FrameKind = keyof typeof FRAME_TYPE;
const KIND_BY_TYPE = new Map<number, FrameKind>(Object.entries(FRAME_TYPE).map(([kind, type]) => [type, kind as FrameKind]));

export type EgressFrame =
  | { type: "open"; id: number; host: string; port: number }
  | { type: "opened"; id: number }
  | { type: "refused"; id: number; reason: SocksReply; message: string }
  | { type: "data"; id: number; data: Uint8Array }
  | { type: "close"; id: number }
  | { type: "reset"; id: number }
  | { type: "pause"; id: number }
  | { type: "resume"; id: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class EgressProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "EgressProtocolError"; }
}

export function isValidEgressHost(host: unknown): host is string {
  return typeof host === "string" && host.length >= 1 && host.length <= EGRESS_HOST_MAX_LENGTH && /^[\x21-\x7e]+$/u.test(host);
}

export function isValidEgressPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

function isSocksReply(value: number): value is SocksReply {
  return Object.values(SOCKS_REPLY).includes(value as SocksReply);
}

function header(type: number, id: number, payloadLength: number): { bytes: Uint8Array; view: DataView } {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new EgressProtocolError("stream id out of range");
  const bytes = new Uint8Array(5 + payloadLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = type;
  view.setUint32(1, id);
  return { bytes, view };
}

export function encodeEgressFrame(frame: EgressFrame): Uint8Array {
  switch (frame.type) {
    case "open": {
      if (!isValidEgressHost(frame.host) || !isValidEgressPort(frame.port)) throw new EgressProtocolError("invalid open target");
      const host = encoder.encode(frame.host);
      const { bytes, view } = header(FRAME_TYPE.open, frame.id, 2 + host.length);
      view.setUint16(5, frame.port);
      bytes.set(host, 7);
      return bytes;
    }
    case "refused": {
      if (!isSocksReply(frame.reason)) throw new EgressProtocolError("invalid refusal reason");
      const message = encoder.encode(frame.message.slice(0, 200));
      const { bytes } = header(FRAME_TYPE.refused, frame.id, 1 + message.length);
      bytes[5] = frame.reason;
      bytes.set(message, 6);
      return bytes;
    }
    case "data": {
      if (frame.data.byteLength > EGRESS_DATA_CHUNK_BYTES) throw new EgressProtocolError("data frame too large");
      const { bytes } = header(FRAME_TYPE.data, frame.id, frame.data.byteLength);
      bytes.set(frame.data, 5);
      return bytes;
    }
    default:
      return header(FRAME_TYPE[frame.type], frame.id, 0).bytes;
  }
}

function decodeOpen(view: DataView, payload: Uint8Array, id: number): EgressFrame {
  if (payload.byteLength < 3) throw new EgressProtocolError("open frame truncated");
  const port = view.getUint16(5);
  let host: string;
  try { host = decoder.decode(payload.subarray(2)); } catch { throw new EgressProtocolError("open host is not utf-8"); }
  if (!isValidEgressHost(host) || !isValidEgressPort(port)) throw new EgressProtocolError("invalid open target");
  return { type: "open", id, host, port };
}

function decodeRefused(payload: Uint8Array, id: number): EgressFrame {
  if (payload.byteLength < 1 || !isSocksReply(payload[0]!)) throw new EgressProtocolError("invalid refusal reason");
  let message: string;
  try { message = decoder.decode(payload.subarray(1)); } catch { throw new EgressProtocolError("refusal message is not utf-8"); }
  return { type: "refused", id, reason: payload[0] as SocksReply, message };
}

export function decodeEgressFrame(input: Uint8Array): EgressFrame {
  if (input.byteLength < 5 || input.byteLength > EGRESS_MAX_FRAME_BYTES) throw new EgressProtocolError("frame length out of range");
  const kind = KIND_BY_TYPE.get(input[0]!);
  if (!kind) throw new EgressProtocolError(`unknown frame type ${input[0]}`);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const id = view.getUint32(1);
  const payload = input.subarray(5);
  if (kind === "open") return decodeOpen(view, payload, id);
  if (kind === "refused") return decodeRefused(payload, id);
  if (kind === "data") return { type: "data", id, data: payload };
  if (payload.byteLength !== 0) throw new EgressProtocolError(`${kind} frame carries a payload`);
  return { type: kind, id };
}
