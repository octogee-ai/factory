import { describe, it, expect } from "vitest";
import {
  CREW_ROLES,
  CREW_IDENTITY,
} from "@octogee/core/crew";

describe("CREW_ROLES", () => {
  it("contains only agent", () => {
    expect(CREW_ROLES).toEqual(["coach"]);
  });
});

describe("CREW_IDENTITY", () => {
  it("coach is Octo with octopus emoji and GPT-6.1 Terra (Everyday) via platform OpenAI as the provisioning default", () => {
    expect(CREW_IDENTITY.coach.name).toBe("Octo");
    expect(CREW_IDENTITY.coach.emoji).toBe("🐙");
    expect(CREW_IDENTITY.coach.model).toBe("platform-openai/gpt-6.1-terra");
  });
});
