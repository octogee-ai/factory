import { describe, expect, it } from "vitest";
import {
  BRAND_LOOK_COLOR,
  CHARACTER_STYLES,
  DEFAULT_AGENT_LOOK,
  LOOK_COLORS,
  OCTO_MASCOT,
  characterBackSvg,
  characterSvg,
} from "./agent-characters.js";
import { parseAgentLook } from "./agent-look.js";

const count = (svg: string, needle: string) => svg.split(needle).length - 1;

describe("agent characters", () => {
  it("defaults every new coach to the coral Octo", () => {
    expect(DEFAULT_AGENT_LOOK).toEqual({ style: "octo", color: BRAND_LOOK_COLOR });
    expect(parseAgentLook(DEFAULT_AGENT_LOOK)).toEqual(DEFAULT_AGENT_LOOK);
    expect(LOOK_COLORS[0]).toEqual({ name: "Coral", value: BRAND_LOOK_COLOR });
  });

  it.each(CHARACTER_STYLES)("draws %s with a body and two blinking eyes in the chosen colour", (style) => {
    const svg = characterSvg({ style, color: "#0ea5e9" });
    expect(count(svg, 'data-part="body"')).toBe(1);
    expect(count(svg, 'data-part="eye"')).toBe(2);
    expect(count(svg, 'data-part="pupil"')).toBe(2);
    expect(count(svg, "data-mouth=")).toBe(5);
    expect(count(svg, 'display="none"')).toBe(4);
    expect(svg).toContain("#0ea5e9");
    expect(svg).not.toContain("#e74e3c");
  });

  it.each(CHARACTER_STYLES)("turns %s around to a faceless back", (style) => {
    const back = characterBackSvg({ style, color: "#0ea5e9" });
    expect(count(back, 'data-part="body"')).toBe(1);
    expect(back).not.toContain('data-part="eye"');
    expect(back).not.toContain("data-mouth");
  });

  it("gives every armed character a left and a right arm", () => {
    for (const style of CHARACTER_STYLES) {
      const svg = characterSvg({ style, color: "#0ea5e9" });
      expect(count(svg, 'data-part="arm-l"'), style).toBe(count(svg, 'data-part="arm-r"'));
    }
  });

  it("draws Octo from the mascot body and its two three-circle eyes in every offered colour", () => {
    expect(OCTO_MASCOT.eyeCircles).toHaveLength(6);
    for (const { value } of LOOK_COLORS) {
      const svg = characterSvg({ style: "octo", color: value });
      expect(svg).toContain(`<path fill="${value}" d="${OCTO_MASCOT.bodyPath}"/>`);
      for (const circle of OCTO_MASCOT.eyeCircles) expect(svg).toContain(circle);
    }
  });

  it("draws only plain shapes, so the server can rasterize it without external references", () => {
    const svg = characterSvg(DEFAULT_AGENT_LOOK);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toMatch(/<image|<foreignObject|href|<script|<!DOCTYPE|<!ENTITY/i);
  });

  it.each([
    { style: "blob", color: "red" },
    { style: "blob", color: '#0ea5e9" onload="x' },
    { style: "dragon", color: "#0ea5e9" },
  ])("refuses to draw %j", (look) => {
    expect(() => characterSvg(look as never)).toThrow("Not a drawable agent look");
  });
});
