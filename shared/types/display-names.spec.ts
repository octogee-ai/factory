import { describe, it, expect } from "vitest";
import {
  WORKSPACE_VIBE_PRESETS,
  DEFAULT_VIBE_NOUN,
  computeWorkspaceDisplayName,
  computeProjectChannelDisplayName,
  WORKSPACE_CHANNEL_DISPLAY_NAMES,
  TYPING_PHRASES_BY_VIBE,
  DEFAULT_TYPING_PHRASES,
  isWorkspaceVibe,
} from "./display-names.js";

describe("computeWorkspaceDisplayName", () => {
  describe("firstName + vibe", () => {
    it.each([
      ["office", "Office"],
      ["garage", "Garage"],
      ["shop", "Shop"],
      ["studio", "Studio"],
      ["clubhouse", "Clubhouse"],
      ["crib", "Crib"],
    ])("renders \"Joe's %s\" → \"Joe's %s\"", (vibe, titleCase) => {
      expect(
        computeWorkspaceDisplayName({ slug: "joe42", firstName: "Joe", vibe }),
      ).toBe(`Joe's ${titleCase}`);
    });

    it("ignores unknown vibes and falls back to Workspace", () => {
      expect(
        computeWorkspaceDisplayName({ slug: "joe42", firstName: "Joe", vibe: "dungeon" }),
      ).toBe("Joe's Workspace");
    });

    it("ignores empty-string vibe", () => {
      expect(
        computeWorkspaceDisplayName({ slug: "joe42", firstName: "Joe", vibe: "" }),
      ).toBe("Joe's Workspace");
    });

    it("does not accept TitleCase input (values are lowercase)", () => {
      expect(
        computeWorkspaceDisplayName({ slug: "joe42", firstName: "Joe", vibe: "Garage" }),
      ).toBe("Joe's Workspace");
    });
  });

  describe("firstName without vibe", () => {
    it("defaults to '{firstName}'s Workspace'", () => {
      expect(computeWorkspaceDisplayName({ slug: "joe42", firstName: "Joe" })).toBe(
        "Joe's Workspace",
      );
    });

    it("trims surrounding whitespace on firstName", () => {
      expect(
        computeWorkspaceDisplayName({ slug: "joe42", firstName: "  Joe  " }),
      ).toBe("Joe's Workspace");
    });

    it("treats whitespace-only firstName as absent", () => {
      expect(computeWorkspaceDisplayName({ slug: "joe42", firstName: "   " })).toBe(
        "joe42's Workspace",
      );
    });
  });

  describe("no firstName (slug fallback)", () => {
    it("uses slug when firstName is undefined", () => {
      expect(computeWorkspaceDisplayName({ slug: "joe42" })).toBe("joe42's Workspace");
    });

    it("uses slug when firstName is null", () => {
      expect(computeWorkspaceDisplayName({ slug: "joe42", firstName: null })).toBe(
        "joe42's Workspace",
      );
    });

    it("applies vibe to slug-based name", () => {
      expect(
        computeWorkspaceDisplayName({ slug: "joe42", vibe: "garage" }),
      ).toBe("joe42's Garage");
    });
  });

  describe("invariants", () => {
    it("throws if slug is empty", () => {
      expect(() => computeWorkspaceDisplayName({ slug: "" })).toThrow();
    });

    it("throws if slug is whitespace-only", () => {
      expect(() => computeWorkspaceDisplayName({ slug: "   " })).toThrow();
    });

    it("DEFAULT_VIBE_NOUN is 'Workspace'", () => {
      expect(DEFAULT_VIBE_NOUN).toBe("Workspace");
    });

    it("exposes exactly six lowercase vibe presets", () => {
      expect(WORKSPACE_VIBE_PRESETS).toEqual([
        "office",
        "garage",
        "shop",
        "studio",
        "clubhouse",
        "crib",
      ]);
    });
  });
});

describe("isWorkspaceVibe", () => {
  it.each(WORKSPACE_VIBE_PRESETS)("accepts %s", (vibe) => {
    expect(isWorkspaceVibe(vibe)).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isWorkspaceVibe("dungeon")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isWorkspaceVibe("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isWorkspaceVibe(42)).toBe(false);
    expect(isWorkspaceVibe(null)).toBe(false);
    expect(isWorkspaceVibe(undefined)).toBe(false);
  });

  it("rejects TitleCase variants (storage is lowercase)", () => {
    expect(isWorkspaceVibe("Office")).toBe(false);
  });
});

describe("WORKSPACE_CHANNEL_DISPLAY_NAMES", () => {
  it("exposes General / Admin / Coach exactly", () => {
    expect(WORKSPACE_CHANNEL_DISPLAY_NAMES).toEqual({
      general: "General",
      admin: "Admin",
      coach: "Coach",
    });
  });
});

describe("computeProjectChannelDisplayName", () => {
  it("renders '{projectName} General' for the default channel", () => {
    expect(
      computeProjectChannelDisplayName({
        projectName: "My First Car",
        channelName: "General",
      }),
    ).toBe("My First Car General");
  });

  it("renders '{projectName} {channelName}' for custom channels", () => {
    expect(
      computeProjectChannelDisplayName({
        projectName: "My First Car",
        channelName: "Design",
      }),
    ).toBe("My First Car Design");
  });

  it("trims whitespace on both fields", () => {
    expect(
      computeProjectChannelDisplayName({
        projectName: "  My First Car  ",
        channelName: "  General  ",
      }),
    ).toBe("My First Car General");
  });

  it("throws if projectName is empty after trim", () => {
    expect(() =>
      computeProjectChannelDisplayName({ projectName: "   ", channelName: "General" }),
    ).toThrow();
  });

  it("throws if channelName is empty after trim", () => {
    expect(() =>
      computeProjectChannelDisplayName({ projectName: "My Project", channelName: "" }),
    ).toThrow();
  });
});

describe("TYPING_PHRASES_BY_VIBE", () => {
  it("has a non-empty phrase list for every preset vibe", () => {
    for (const vibe of WORKSPACE_VIBE_PRESETS) {
      expect(Array.isArray(TYPING_PHRASES_BY_VIBE[vibe])).toBe(true);
      expect(TYPING_PHRASES_BY_VIBE[vibe].length).toBeGreaterThan(0);
      for (const phrase of TYPING_PHRASES_BY_VIBE[vibe]) {
        expect(typeof phrase).toBe("string");
        expect(phrase.length).toBeGreaterThan(0);
      }
    }
  });

  it("DEFAULT_TYPING_PHRASES is non-empty (fallback for no-vibe)", () => {
    expect(Array.isArray(DEFAULT_TYPING_PHRASES)).toBe(true);
    expect(DEFAULT_TYPING_PHRASES.length).toBeGreaterThan(0);
  });
});
