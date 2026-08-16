import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";

export const VAD_SAMPLE_RATE = 16_000;
export const VAD_FRAME_SAMPLES = 512;

const SILERO_MODEL_SPECIFIER = "@ricky0123/vad-web/dist/silero_vad_v5.onnx";
const STATE_SHAPE = [2, 1, 128] as const;

export interface SpeechProbabilityModel {
  process(frame: Float32Array): Promise<number>;
  reset(): void;
}

/**
 * Silero VAD v5 on the WASM execution provider (no native addon). One instance per
 * Talk session; the ONNX session is shared process-wide because it is immutable and
 * loading it costs ~200 ms.
 */
export class SileroVad implements SpeechProbabilityModel {
  private state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [...STATE_SHAPE]);
  private readonly sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), []);

  private constructor(private readonly session: ort.InferenceSession) {}

  static async create(session?: ort.InferenceSession): Promise<SileroVad> {
    return new SileroVad(session ?? (await loadSileroSession()));
  }

  reset(): void {
    this.state = new ort.Tensor("float32", new Float32Array(2 * 128), [...STATE_SHAPE]);
  }

  async process(frame: Float32Array): Promise<number> {
    if (frame.length !== VAD_FRAME_SAMPLES) {
      throw new Error(`Silero VAD expects ${VAD_FRAME_SAMPLES}-sample frames, got ${frame.length}`);
    }
    const out = await this.session.run({
      input: new ort.Tensor("float32", frame, [1, VAD_FRAME_SAMPLES]),
      state: this.state,
      sr: this.sr,
    });
    this.state = out.stateN as ort.Tensor;
    const value = (out.output as ort.Tensor).data[0];
    return typeof value === "number" ? value : Number(value);
  }
}

let sharedSession: Promise<ort.InferenceSession> | null = null;

export function loadSileroSession(): Promise<ort.InferenceSession> {
  if (!sharedSession) {
    ort.env.wasm.numThreads = 1;
    sharedSession = (async () => {
      const require = createRequire(import.meta.url);
      const modelPath = require.resolve(SILERO_MODEL_SPECIFIER);
      const bytes = await readFile(modelPath);
      return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ["wasm"] });
    })().catch((err) => {
      sharedSession = null;
      throw err;
    });
  }
  return sharedSession;
}

/** Accumulates arbitrary PCM16 chunks into fixed VAD frames as Float32 [-1, 1]. */
export class VadFramer {
  private carry = new Int16Array(0);

  push(pcm16le: Buffer): Float32Array[] {
    const incoming = new Int16Array(pcm16le.buffer, pcm16le.byteOffset, Math.floor(pcm16le.byteLength / 2));
    const samples = new Int16Array(this.carry.length + incoming.length);
    samples.set(this.carry, 0);
    samples.set(incoming, this.carry.length);
    const frames: Float32Array[] = [];
    let offset = 0;
    while (samples.length - offset >= VAD_FRAME_SAMPLES) {
      const frame = new Float32Array(VAD_FRAME_SAMPLES);
      for (let i = 0; i < VAD_FRAME_SAMPLES; i++) frame[i] = samples[offset + i] / 32768;
      frames.push(frame);
      offset += VAD_FRAME_SAMPLES;
    }
    this.carry = samples.slice(offset);
    return frames;
  }

  reset(): void {
    this.carry = new Int16Array(0);
  }
}
