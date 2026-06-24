import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readAuthProfileStore,
  writeAuthProfileStore,
} from "../lib/auth-profile-sqlite.js";
import {
  agentModelTokenProfileEntry,
  materializeAnthropicBrokerForAgents,
  upsertAnthropicBrokerProfile,
} from "../lib/agent-model-token-materializer.js";

describe("agent-model-token materializer", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-"));
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("creates the anthropic:default broker-token profile on an empty store", () => {
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-alice-coach")).toBe(true);
    const store = readAuthProfileStore(agentDir) as { profiles: Record<string, unknown> };
    expect(store.profiles["anthropic:default"]).toEqual(
      agentModelTokenProfileEntry("octogee-alice-coach"),
    );
    expect(
      (store.profiles["anthropic:default"] as { keyRef: { id: string } }).keyRef.id,
    ).toBe("agent-model-token-octogee-alice-coach");
  });

  it("MERGES into an existing byosub OAuth store — preserves the OAuth primary and version", () => {
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "openai-codex": {
          type: "oauth",
          provider: "openai-codex",
          access: "acc",
          refresh: "ref",
          expires: 0,
        },
      },
    });
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-bob-coach")).toBe(true);

    const store = readAuthProfileStore(agentDir) as {
      version: number;
      profiles: Record<string, unknown>;
    };
    expect(store.version).toBe(1); // top-level preserved
    expect(store.profiles["openai-codex"]).toMatchObject({ type: "oauth", access: "acc" }); // not clobbered
    expect(store.profiles["anthropic:default"]).toEqual(
      agentModelTokenProfileEntry("octogee-bob-coach"),
    );
  });

  it("MERGES alongside a claude-cli OAuth primary (the adjacent anthropic:-keyed profile)", () => {
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "acc",
          refresh: "ref",
          expires: 0,
        },
      },
    });
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-cc-coach")).toBe(true);
    const store = readAuthProfileStore(agentDir) as { profiles: Record<string, unknown> };
    // both anthropic:-keyed profiles coexist — the exact shape the connect path needs
    expect(store.profiles["anthropic:claude-cli"]).toMatchObject({ type: "oauth", access: "acc" });
    expect(store.profiles["anthropic:default"]).toEqual(agentModelTokenProfileEntry("octogee-cc-coach"));
  });

  it("is idempotent — a second upsert is a no-op write", () => {
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-alice-coach")).toBe(true);
    expect(upsertAnthropicBrokerProfile(agentDir, "octogee-alice-coach")).toBe(false);
  });
});

describe("materializeAnthropicBrokerForAgents (boot/reconcile sweep)", () => {
  let agentsDir: string;
  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-amt-loop-"));
  });
  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("materializes anthropic:default for each agent under agentsDir/<id>/agent", () => {
    expect(
      materializeAnthropicBrokerForAgents(["octogee-a-coach", "octogee-b-coach"], { agentsDir }),
    ).toBe(2);
    const store = readAuthProfileStore(path.join(agentsDir, "octogee-a-coach", "agent")) as {
      profiles: Record<string, { keyRef: { id: string } }>;
    };
    expect(store.profiles["anthropic:default"].keyRef.id).toBe("agent-model-token-octogee-a-coach");
  });

  it("is tolerant — a failure on one agent does not abort the sweep", () => {
    // a path collision (file where the agent dir should be) makes one agent fail
    fs.writeFileSync(path.join(agentsDir, "octogee-bad-coach"), "x");
    expect(
      materializeAnthropicBrokerForAgents(["octogee-good-coach", "octogee-bad-coach"], { agentsDir }),
    ).toBe(1);
  });

  it("skips non-coach agent ids (no broker-token resolver grammar → fail closed)", () => {
    expect(
      materializeAnthropicBrokerForAgents(["octogee-a-coach", "octogee-a-alex", "main"], { agentsDir }),
    ).toBe(1);
    expect(readAuthProfileStore(path.join(agentsDir, "octogee-a-alex", "agent"))).toBeNull();
  });
});
