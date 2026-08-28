import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_ACTIVITY_ENVELOPE_SCHEMA_VERSION,
  AGENT_ACTIVITY_RESERVED_ITEM_IDS,
  AGENT_CONVERSATION_SCHEMA_VERSION,
  agentActivityCanonicalKey,
  type AgentActivityEnvelopeV1,
  type AgentAdmissionRef,
  type AgentRunRef,
  type ActivityCreateRef,
  type ConversationProjectionRef,
} from "../../shared/types/index.js";

const FIXTURES = path.resolve(__dirname, "../fixtures/agent-conversation");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as T;
}

function projection(value: unknown): ConversationProjectionRef {
  return value as ConversationProjectionRef;
}

describe("agent conversation v3 type contract", () => {
  it("exports one breaking run/admission projection union from the shared barrel", () => {
    const run: AgentRunRef = {
      schemaVersion: 3,
      projectionKind: "run",
      conversationId: "main-1",
      turnId: "turn-1",
      runId: "run-1",
      origin: "human",
      status: "running",
      mainChannelId: "main-1",
      mainRootPostId: "turn-1",
      activityChannelId: "activity-1",
      attention: "routine",
    };
    const admission: AgentAdmissionRef = {
      schemaVersion: 3,
      projectionKind: "admission",
      conversationId: "main-1",
      turnId: "turn-2",
      mainChannelId: "main-1",
      activityChannelId: "activity-1",
      inputPostId: "turn-2",
      origin: "followup",
      status: "queued",
      attention: "routine",
    };
    const projections: ConversationProjectionRef[] = [run, admission];

    expect(AGENT_CONVERSATION_SCHEMA_VERSION).toBe(3);
    expect(projections.map((value) => value.projectionKind)).toEqual(["run", "admission"]);
  });

  it("keeps admission identity honest: turn/input IDs are required and runId is impossible", () => {
    type AdmissionHasRunId = "runId" extends keyof AgentAdmissionRef ? true : false;
    const admissionHasRunId: AdmissionHasRunId = false;
    expect(admissionHasRunId).toBe(false);
  });

  it("requires a complete item identity on every Activity create", () => {
    type IsRequired<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? false : true;
    const required: Array<IsRequired<ActivityCreateRef, "itemId" | "ordinal" | "semanticVersion">> = [
      true,
    ];
    expect(required).toEqual([true]);
  });

  it("publishes the contract from both shared package entrypoints", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../shared/package.json"), "utf8"),
    ) as {
      exports: Record<string, { types: string; default: string }>;
      typesVersions: Record<string, Record<string, string[]>>;
    };

    expect(packageJson.exports["./types/agent-conversation"]).toEqual({
      types: "./dist/types/agent-conversation.d.ts",
      default: "./dist/types/agent-conversation.js",
    });
    expect(packageJson.typesVersions["*"]["types/agent-conversation"]).toEqual([
      "dist/types/agent-conversation.d.ts",
    ]);
  });

  it("keeps the shared contract browser-neutral", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../shared/types/agent-conversation.ts"),
      "utf8",
    );
    expect(source).not.toContain("node:crypto");
    expect(source).not.toContain("createHash");
    expect(source).not.toContain("agentActivityEventKey");
    expect(readFileSync(path.resolve(__dirname, "../../shared/types/index.ts"), "utf8")).not.toContain(
      "agentActivityEventKey",
    );
  });
});

type PlacementFixture = {
  primaryPosts: Array<{ id: string; channel_id: string; root_id: string; props: { octogee: unknown } }>;
  activityPosts: Array<{ id: string; channel_id: string; root_id: string; props: { octogee: Record<string, unknown> } }>;
  expected: {
    rootAdoptions: Array<{
      mainRootPostId: string;
      activityRootPostId: string;
      createdPostCount: number;
      updateCount: number;
    }>;
  };
};

describe("agent conversation projection fixtures", () => {
  const placement = fixture<PlacementFixture>("projection-placement.json");

  it("places same-channel Mattermost refs directly at props.octogee", () => {
    for (const post of [...placement.primaryPosts, ...placement.activityPosts]) {
      expect(post.props.octogee).toHaveProperty("projectionKind");
      expect(post.props.octogee).not.toHaveProperty("ref");
      const ref = projection(post.props.octogee);
      expect(post.channel_id).toBe(ref.mainChannelId);
      expect(ref.activityChannelId).toBe(ref.mainChannelId);
    }
  });

  it("keys every admission by inputPostId so queued inputs never collide", () => {
    const admissions = placement.primaryPosts.filter(
      ({ props }) => projection(props.octogee).projectionKind === "admission",
    );
    expect(admissions.length).toBeGreaterThanOrEqual(2);
    const inputPostIds = admissions.map(({ props }) => {
      const ref = projection(props.octogee);
      if (ref.projectionKind !== "admission") throw new Error("expected admission fixture");
      expect(ref).not.toHaveProperty("runId");
      expect(ref.turnId).toBeTruthy();
      expect(ref.inputPostId).toBeTruthy();
      return ref.inputPostId;
    });
    expect(new Set(inputPostIds).size).toBe(admissions.length);
  });

  it("keeps conversationId and mainChannelId aliases equal in every projection", () => {
    const values = [
      ...placement.primaryPosts.map(({ props }) => props.octogee),
      ...placement.activityPosts.map(({ props }) => props.octogee),
    ];
    for (const value of values) {
      const ref = projection(value);
      expect(ref.conversationId).toBe(ref.mainChannelId);
    }
  });

  it("adopts the existing Mattermost turn root without creating or editing an Activity root", () => {
    for (const expected of placement.expected.rootAdoptions) {
      expect(expected.activityRootPostId).toBe(expected.mainRootPostId);
      expect(expected.createdPostCount).toBe(0);
      expect(expected.updateCount).toBe(0);
    }
  });
});

type EnvelopeFixture = {
  envelopes: AgentActivityEnvelopeV1[];
  transportResponses: Record<string, { status: number; outcome?: string; retryable: boolean }>;
};

describe("agent activity envelope v1 fixtures", () => {
  const activity = fixture<EnvelopeFixture>("agent-activity-envelopes.json");

  it("covers the complete envelope, activity-kind, item-status, transition, and outcome unions", () => {
    expect(AGENT_ACTIVITY_ENVELOPE_SCHEMA_VERSION).toBe(1);
    expect(new Set(activity.envelopes.map(({ type }) => type))).toEqual(
      new Set(["turn.started", "item.completed", "control.transition", "turn.finalized"]),
    );

    const items = activity.envelopes.filter(
      (value): value is Extract<AgentActivityEnvelopeV1, { type: "item.completed" }> =>
        value.type === "item.completed",
    );
    expect(new Set(items.map(({ item }) => item.kind))).toEqual(
      new Set([
        "commentary", "tool", "plan", "patch", "checkpoint",
        "compaction", "fallback", "approval", "error",
      ]),
    );
    expect(new Set(items.map(({ item }) => item.status))).toEqual(
      new Set(["completed", "failed", "waiting"]),
    );

    const transitions = activity.envelopes.filter(
      (value): value is Extract<AgentActivityEnvelopeV1, { type: "control.transition" }> =>
        value.type === "control.transition",
    );
    expect(new Set(transitions.map(({ control }) => control.to))).toEqual(
      new Set(["approved", "denied", "expired"]),
    );
    const approvalCreates = items.filter(({ item }) => item.kind === "approval");
    const waitingApprovals = new Set(
      approvalCreates.map(({ ref }) => `${ref.runId}:${ref.itemId}`),
    );
    expect(approvalCreates).toHaveLength(3);
    expect(new Set(transitions.map(({ ref }) => `${ref.runId}:${ref.itemId}`)).size).toBe(3);
    for (const create of approvalCreates) {
      expect(create.ref.semanticVersion).toBe(1);
      expect(create.item.status).toBe("waiting");
    }
    for (const transition of transitions) {
      expect(transition.ref.semanticVersion).toBe(2);
      expect(transition.control.from).toBe("waiting");
      expect(waitingApprovals).toContain(`${transition.ref.runId}:${transition.ref.itemId}`);
    }

    const finalizations = activity.envelopes.filter(
      (value): value is Extract<AgentActivityEnvelopeV1, { type: "turn.finalized" }> =>
        value.type === "turn.finalized",
    );
    expect(new Set(finalizations.map(({ outcome }) => outcome))).toEqual(
      new Set(["completed", "failed", "stopped"]),
    );
  });

  it("uses reserved lifecycle IDs and the canonical lowercase SHA-256 event key", () => {
    expect(AGENT_ACTIVITY_RESERVED_ITEM_IDS).toEqual({
      runRoot: "octogee:run-root",
      turnFinalized: "octogee:turn-finalized",
      terminalError: "octogee:terminal-error",
      approvalPrefix: "octogee:approval:",
    });
    for (const envelope of activity.envelopes) {
      const canonical = `v1\n${envelope.ref.conversationId}\n${envelope.ref.runId}\n${envelope.ref.itemId}\n${envelope.ref.semanticVersion}`;
      expect(agentActivityCanonicalKey(envelope.ref)).toBe(canonical);
      expect(envelope.eventKey).toBe(
        createHash("sha256").update(canonical, "utf8").digest("hex"),
      );
      expect(envelope.eventKey).toMatch(/^[a-f0-9]{64}$/);
      expect(envelope.ref).not.toHaveProperty("activityChannelId");
    }

    const reserved = (itemId: string) =>
      itemId === AGENT_ACTIVITY_RESERVED_ITEM_IDS.runRoot ||
      itemId === AGENT_ACTIVITY_RESERVED_ITEM_IDS.turnFinalized ||
      itemId === AGENT_ACTIVITY_RESERVED_ITEM_IDS.terminalError ||
      itemId.startsWith(AGENT_ACTIVITY_RESERVED_ITEM_IDS.approvalPrefix);
    for (const { ref } of activity.envelopes) {
      expect(ref.itemId.startsWith("octogee:") ? reserved(ref.itemId) : true).toBe(true);
    }
    for (const envelope of activity.envelopes) {
      if (envelope.type !== "item.completed") continue;
      if (envelope.item.kind === "approval" || envelope.item.kind === "error") continue;
      expect(envelope.ref.itemId).not.toMatch(/^octogee:/);
    }
  });

  it("pins persisted, duplicate, conflict, authorization, size, schema, and retryable statuses", () => {
    expect(activity.transportResponses).toEqual({
      persisted: { status: 201, outcome: "persisted", retryable: false },
      duplicate: { status: 200, outcome: "duplicate", retryable: false },
      conflict: { status: 409, retryable: false },
      unauthenticated: { status: 401, retryable: false },
      forbidden: { status: 403, retryable: false },
      tooLarge: { status: 413, retryable: false },
      invalid: { status: 422, retryable: false },
      unavailable: { status: 503, retryable: true },
    });
  });
});

type ReferenceTurnFixture = {
  source: { repository: string; commit: string; files: string[] };
  rows: Array<{ type: "commentary" | "tool"; itemId: string; body?: string; name?: string; detail?: string }>;
  expected: { orderedItemIds: string[]; finalAnswer: string; complete: boolean; defaultExpanded: boolean };
};

type CumulativeFixture = {
  frames: Array<{ sequence: number; lane: string; itemId: string; value: string }>;
  expected: { durableItems: Array<{ itemId: string; ordinal: number; text: string }>; finalAnswer: string };
};

describe("headless conversation behavior fixtures", () => {
  it("captures the pinned ClickClack commentary/tool preamble reference turn", () => {
    const reference = fixture<ReferenceTurnFixture>("clickclack-reference-turn.json");
    expect(reference.source.repository).toBe("openclaw/clickclack");
    expect(reference.source.commit).toBe("f441a9c6e05b871e3a8cf7de810d23cc1292ecae");
    expect(reference.rows.map(({ itemId }) => itemId)).toEqual(reference.expected.orderedItemIds);
    expect(reference.rows.map(({ type }) => type)).toEqual(["commentary", "tool"]);
    expect(reference.expected.complete).toBe(true);
    expect(reference.expected.defaultExpanded).toBe(false);
    expect(reference.expected.finalAnswer).toBeTruthy();
  });

  it("reconciles cumulative commentary prefixes once while preserving tool interleaving", () => {
    const cumulative = fixture<CumulativeFixture>("cumulative-stream.json");
    expect(cumulative.frames.map(({ sequence }) => sequence)).toEqual(
      [...cumulative.frames.map(({ sequence }) => sequence)].sort((a, b) => a - b),
    );
    expect(cumulative.expected.durableItems.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3, 4]);
    expect(cumulative.expected.durableItems.map(({ itemId }) => itemId)).toEqual([
      "commentary-1", "tool-1", "commentary-2", "tool-2",
    ]);
    const rendered = cumulative.expected.durableItems.map(({ text }) => text).join("\n");
    expect(rendered.match(/First thought\./g)).toHaveLength(1);
    expect(rendered.match(/After tool\./g)).toHaveLength(1);
    expect(rendered).not.toContain(cumulative.expected.finalAnswer);
  });
});

type IdentityFixture = {
  cases: Array<{
    name: string;
    projections: ConversationProjectionRef[];
    expected: Record<string, unknown>;
  }>;
  degradationCases: Array<{ name: string; available: string[]; missing: string[]; expectedBehavior: string }>;
};

function identityCase(identity: IdentityFixture, name: string): IdentityFixture["cases"][number] {
  const value = identity.cases.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`missing identity fixture: ${name}`);
  return value;
}

describe("identity and degraded-projection fixtures", () => {
  const identity = fixture<IdentityFixture>("identity-scenarios.json");

  it("pins steer inputPostId, retry, subagent, and scheduled identity", () => {
    const steer = identityCase(identity, "steer");
    const retry = identityCase(identity, "retry");
    const subagent = identityCase(identity, "subagent");
    const scheduled = identityCase(identity, "scheduled");

    expect(steer.projections[0]).toMatchObject(steer.expected);
    expect(retry.projections[0]).toMatchObject(retry.expected);
    expect(subagent.projections[0]).toMatchObject(subagent.expected);
    expect(scheduled.projections[0]).toMatchObject(scheduled.expected);
  });

  it("pins admission-to-steer without inventing or changing run identity", () => {
    const queueToSteer = identityCase(identity, "queue-to-steer");
    expect(queueToSteer.projections).toHaveLength(2);
    const [queued, admitted] = queueToSteer.projections;
    expect(queued?.projectionKind).toBe("admission");
    expect(queued).not.toHaveProperty("runId");
    expect(admitted?.projectionKind).toBe("run");
    expect(admitted).toMatchObject(queueToSteer.expected);
    expect(admitted?.inputPostId).toBe(queued?.inputPostId);
  });

  it("renders partial Mattermost history without timestamp joins", () => {
    expect(identity.degradationCases.map(({ name }) => name)).toEqual([
      "late-detail", "summary-only", "activity-only",
    ]);
    for (const value of identity.degradationCases) {
      expect(value.expectedBehavior).not.toMatch(/timestamp|fabricat/i);
      expect(value.available.length + value.missing.length).toBeGreaterThan(0);
    }
  });
});

describe("agent conversation fixture corpus", () => {
  it("contains only the frozen JSON conformance files", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual([
      "agent-activity-envelopes.json",
      "chatgpt-claude-conversation-reference.json",
      "clickclack-reference-turn.json",
      "cumulative-stream.json",
      "identity-scenarios.json",
      "openclaw-control-ui-reference.json",
      "projection-placement.json",
    ]);
  });
});
