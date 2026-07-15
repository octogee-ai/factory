import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  openClawConfigPath,
  openClawDir,
} from "../lib/openclaw-config-path.js";

describe("OpenClaw config path", () => {
  it("uses OPENCLAW_CONFIG_PATH as the canonical active file", () => {
    expect(openClawConfigPath({
      HOME: "/home/customer",
      OPENCLAW_CONFIG_PATH: "/durable/system_config/openclaw.json",
    })).toBe("/durable/system_config/openclaw.json");
  });

  it("falls back to the OpenClaw directory for shared and local runtimes", () => {
    expect(openClawDir({ HOME: "/home/customer" })).toBe("/home/customer/.openclaw");
    expect(openClawConfigPath({ HOME: "/home/customer" })).toBe(
      path.join("/home/customer", ".openclaw", "openclaw.json"),
    );
  });

  it("ignores blank path overrides", () => {
    expect(openClawConfigPath({
      HOME: "/home/customer",
      OPENCLAW_CONFIG_PATH: "   ",
    })).toBe("/home/customer/.openclaw/openclaw.json");
  });
});
