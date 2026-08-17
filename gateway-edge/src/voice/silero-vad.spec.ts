import { describe, expect, it } from "vitest";
import { SileroVad, VAD_FRAME_SAMPLES, VadFramer } from "./silero-vad.js";

describe("VadFramer", () => {
  it("emits fixed 512-sample float frames and carries the remainder across pushes", () => {
    const framer = new VadFramer();
    const first = Buffer.alloc(600 * 2);
    first.writeInt16LE(16384, 0);
    expect(framer.push(first)).toHaveLength(1);
    const second = Buffer.alloc(424 * 2);
    const frames = framer.push(second);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(VAD_FRAME_SAMPLES);
    const third = framer.push(Buffer.alloc(0));
    expect(third).toHaveLength(0);
    framer.reset();
    expect(framer.push(Buffer.alloc(511 * 2))).toHaveLength(0);
  });

  it("accepts frames that are odd-offset slices of a shared pool, as ws delivers them", () => {
    const pool = Buffer.alloc(3 + VAD_FRAME_SAMPLES * 2 * 2);
    pool.writeInt16LE(16384, 3);
    pool.writeInt16LE(-32768, 3 + VAD_FRAME_SAMPLES * 2);
    const message = pool.subarray(3, 3 + VAD_FRAME_SAMPLES * 2 * 2);
    expect(message.byteOffset % 2).toBe(1);
    const frames = new VadFramer().push(message);
    expect(frames).toHaveLength(2);
    expect(frames[0][0]).toBeCloseTo(0.5, 5);
    expect(frames[1][0]).toBe(-1);
  });

  it("scales samples into [-1, 1]", () => {
    const framer = new VadFramer();
    const buf = Buffer.alloc(VAD_FRAME_SAMPLES * 2);
    buf.writeInt16LE(-32768, 0);
    buf.writeInt16LE(16384, 2);
    const [frame] = framer.push(buf);
    expect(frame[0]).toBe(-1);
    expect(frame[1]).toBeCloseTo(0.5, 5);
  });
});

describe("SileroVad", () => {
  it("loads the bundled model on the WASM provider and scores silence low", async () => {
    const vad = await SileroVad.create();
    const silence = new Float32Array(VAD_FRAME_SAMPLES);
    let probability = 1;
    for (let i = 0; i < 5; i++) probability = await vad.process(silence);
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThan(0.2);
    await expect(vad.process(new Float32Array(100))).rejects.toThrow(/512-sample/);
  }, 20_000);
});
