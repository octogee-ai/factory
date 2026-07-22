import { describe, expect, it } from "vitest";
import {
  acceptanceDocId,
  currentVersion,
  decodeFrame,
  encodeStdin,
  GATEWAY_CLASSES,
  isLegalDocId,
  modelCredentialEntryById,
  OPENCLAW_PROTOCOL_VERSION,
  OpenclawWireError,
  PTY_FRAME,
  resolveGatewayClass,
  resolveSizingTier,
  type Agent,
  type Project,
  type PtyFrame,
} from "./index.js";

describe("shared type barrel", () => {
  it("re-exports public runtime helpers from the root shared entrypoint", () => {
    expect(isLegalDocId("terms")).toBe(true);
    expect(acceptanceDocId("terms", currentVersion("terms"))).toBe("terms@2026-07-22");
    expect(GATEWAY_CLASSES).toContain("operator");
    expect(resolveGatewayClass({ gatewayClass: "operator" })).toBe("operator");
    expect(resolveSizingTier({ sizingTier: "medium" }).tier).toBe("medium");
    expect(modelCredentialEntryById("openai").displayName).toBe("OpenAI API key");
    expect(OPENCLAW_PROTOCOL_VERSION).toBe(4);
    expect(new OpenclawWireError("timeout", "late").code).toBe("timeout");
  });

  it("re-exports PTY helpers through the root shared entrypoint", () => {
    const frame: PtyFrame = decodeFrame(encodeStdin(new TextEncoder().encode("hello")));

    expect(frame.type).toBe(PTY_FRAME.STDIN);
    if (frame.type !== PTY_FRAME.STDIN) {
      throw new Error("expected stdin frame");
    }
    expect(new TextDecoder().decode(frame.data)).toBe("hello");
  });

  it("keeps consumer-facing document types reachable from the root barrel", () => {
    const agent: Agent = {
      id: "agent-1",
      name: "Scout",
      persona: "calm builder coach",
      avatar: {
        path: "Scout-avatar.png",
        gcsPath: "workspaces/scout/Scout-avatar.png",
        updatedAt: "server-time",
      },
      mattermost: { userId: "mm-agent-1" },
      createdAt: "server-time",
      updatedAt: "server-time",
    };
    const project: Project = {
      id: "project-1",
      ownerUid: "uid-1",
      workspaceId: "workspace-1",
      slug: "first-build",
      name: "First Build",
      tagline: "Make it real",
      description: "A first project",
      category: "tools",
      projectType: "other",
      status: "building",
      visibility: "private",
      provisioningState: "active",
      giteaRepoName: "workspace-first-build",
      canvasFile: "README.md",
      publishedUrl: null,
      starCount: 0,
      memberCount: 1,
      createdAt: "server-time",
      updatedAt: "server-time",
    };

    expect(agent.avatar?.path).toBe("Scout-avatar.png");
    expect(project.visibility).toBe("private");
  });
});
