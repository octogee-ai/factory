import { describe, expect, it } from "vitest";
import { decodeEgressFrame, encodeEgressFrame, EGRESS_DATA_CHUNK_BYTES, SOCKS_REPLY, type EgressFrame } from "./protocol.js";

describe("egress multiplex framing", () => {
  it("round-trips every frame kind through one binary message", () => {
    const frames: EgressFrame[] = [
      { type: "open", id: 7, host: "ifconfig.me", port: 443 },
      { type: "open", id: 0xffffffff, host: "2606:4700:4700::1111", port: 1 },
      { type: "opened", id: 7 },
      { type: "refused", id: 7, reason: SOCKS_REPLY.notAllowedByRuleset, message: "private destination" },
      { type: "data", id: 7, data: new Uint8Array([0, 1, 2, 255]) },
      { type: "data", id: 7, data: new Uint8Array(0) },
      { type: "close", id: 7 },
      { type: "reset", id: 7 },
      { type: "pause", id: 7 },
      { type: "resume", id: 7 },
    ];
    for (const frame of frames) {
      const decoded = decodeEgressFrame(encodeEgressFrame(frame));
      if (frame.type === "data") expect(Array.from((decoded as { data: Uint8Array }).data)).toEqual(Array.from(frame.data));
      else expect(decoded).toEqual(frame);
    }
  });

  it("decodes data frames as views over the incoming buffer without copying", () => {
    const encoded = encodeEgressFrame({ type: "data", id: 1, data: new Uint8Array(EGRESS_DATA_CHUNK_BYTES).fill(9) });
    const decoded = decodeEgressFrame(encoded) as { type: "data"; data: Uint8Array };
    expect(decoded.data.byteLength).toBe(EGRESS_DATA_CHUNK_BYTES);
    expect(decoded.data.buffer).toBe(encoded.buffer);
  });

  it("refuses malformed frames instead of guessing", () => {
    expect(() => encodeEgressFrame({ type: "data", id: 1, data: new Uint8Array(EGRESS_DATA_CHUNK_BYTES + 1) })).toThrow();
    expect(() => encodeEgressFrame({ type: "open", id: 1, host: "", port: 80 })).toThrow();
    expect(() => encodeEgressFrame({ type: "open", id: 1, host: "a".repeat(256), port: 80 })).toThrow();
    expect(() => encodeEgressFrame({ type: "open", id: 1, host: "bad host", port: 80 })).toThrow();
    expect(() => encodeEgressFrame({ type: "open", id: 1, host: "example.com", port: 0 })).toThrow();
    expect(() => encodeEgressFrame({ type: "open", id: 1, host: "example.com", port: 65536 })).toThrow();
    expect(() => encodeEgressFrame({ type: "open", id: -1, host: "example.com", port: 80 })).toThrow();
    expect(() => decodeEgressFrame(new Uint8Array([1, 0, 0, 0]))).toThrow();
    expect(() => decodeEgressFrame(new Uint8Array([99, 0, 0, 0, 1]))).toThrow();
    expect(() => decodeEgressFrame(new Uint8Array([2, 0, 0, 0, 1, 1]))).toThrow();
    expect(() => decodeEgressFrame(new Uint8Array([1, 0, 0, 0, 1, 0, 80]))).toThrow();
    expect(() => decodeEgressFrame(new Uint8Array([1, 0, 0, 0, 1, 0, 80, 0xff, 0xfe]))).toThrow();
    expect(() => decodeEgressFrame(new Uint8Array([3, 0, 0, 0, 1, 42]))).toThrow();
    expect(() => decodeEgressFrame(new Uint8Array(EGRESS_DATA_CHUNK_BYTES + 6).fill(4))).toThrow();
  });
});
