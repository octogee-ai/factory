import { describe, expect, it } from "vitest";
import { formatListUsersLine } from "../ops/list-users.js";
import { parseSeedTypingPhrasesArgs } from "../ops/seed-typing-phrases.js";
import { TEST_TARGET } from "./fixtures/deployment.js";

describe("seed typing phrases", () => {
  it("parses seed typing phrase force mode and target project", () => {
    expect(parseSeedTypingPhrasesArgs([])).toEqual({ force: false, project: TEST_TARGET.firebaseProjectId });
    expect(parseSeedTypingPhrasesArgs(["--force", "--project=octogee"])).toEqual({
      force: true,
      project: "octogee",
    });
  });
});

describe("list-users", () => {
  it("formats the compact user list line", () => {
    expect(formatListUsersLine("uid-1", {
      onboardingComplete: true,
      workspaceSlug: "alice",
      email: "alice@example.com",
      selectedTier: "pro",
      provisioning: {
        openclaw: {
          status: "complete",
          activatedAgents: ["coach"],
        },
      },
    })).toContain("uid=uid-1");
  });
});
