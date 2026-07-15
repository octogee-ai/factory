import { describe, expect, it } from "vitest";

import {
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL,
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION,
} from "./fleet-controller.js";

describe("durable OpenClaw config control protocol", () => {
  it("exports one exact capability contract for rollout and Dashboard gates", () => {
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL).toBe("durable-openclaw-config");
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION).toBe(1);
  });
});
