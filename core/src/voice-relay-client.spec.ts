import { describe, expect, it, vi } from "vitest";
import { createVoiceRelayClient } from "./voice-relay-client.js";

function streamOf(chunks: Buffer[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "audio/pcm", "x-voice-sample-rate": "24000" } });
}

describe("voice relay client — tts", () => {
  it("re-frames the relay's byte stream into whole PCM16 samples no matter where the network splits it", async () => {
    const pcm = Buffer.alloc(2 * 1001);
    for (let i = 0; i < 1001; i++) pcm.writeInt16LE(((i * 7919) % 65536) - 32768, i * 2);
    const splits = [pcm.subarray(0, 1), pcm.subarray(1, 300), pcm.subarray(300, 301), pcm.subarray(301, 1503), pcm.subarray(1503)];
    const fetchImpl = vi.fn(async () => streamOf(splits));
    const client = createVoiceRelayClient({ baseUrl: "https://relay.local", gatewayId: "gw-mom", tokenPath: "/nonexistent/token", fetchImpl });
    const frames: Buffer[] = [];
    for await (const frame of client.tts({ text: "hello" })) frames.push(frame);
    for (const frame of frames) expect(frame.length % 2).toBe(0);
    expect(frames.length).toBeGreaterThan(1);
    expect(Buffer.concat(frames).equals(pcm)).toBe(true);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ gatewayId: "gw-mom", text: "hello" });
  });

  it("surfaces relay refusals with the status and body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "too_many_tts_requests" }), { status: 429 }));
    const client = createVoiceRelayClient({ baseUrl: "https://relay.local", gatewayId: "gw-mom", tokenPath: "/nonexistent/token", fetchImpl });
    const drain = async () => {
      const seen: Buffer[] = [];
      for await (const chunk of client.tts({ text: "hello" })) seen.push(chunk);
      return seen;
    };
    await expect(drain()).rejects.toMatchObject({ name: "VoiceRelayError", status: 429, message: expect.stringContaining("too_many_tts_requests") });
  });
});
