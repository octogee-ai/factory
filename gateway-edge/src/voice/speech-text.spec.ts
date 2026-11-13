import { describe, expect, it } from "vitest";
import { SentenceChunker, prepareSpeechText, splitSentences } from "./speech-text.js";

describe("prepareSpeechText", () => {
  it("drops markdown structure that means nothing aloud", () => {
    const md = [
      "## Your day",
      "",
      "Here's what I found — **two** things:",
      "- Call Dr. Lee at 3pm ([details](https://example.com/x))",
      "- Pick up the `prescription` 💊",
      "",
      "```js",
      "console.log('hi')",
      "```",
      "> Remember: bring the card.",
      "See https://octogee.com for more [[reply_to_x]]",
    ].join("\n");
    expect(prepareSpeechText(md)).toBe(
      "Your day. Here's what I found — two things: Call Dr. Lee at 3pm (details). Pick up the prescription. (code omitted). Remember: bring the card. See a link for more.",
    );
  });

  it("reads tables row by row and strips emphasis and tags", () => {
    const md = "| Item | Qty |\n|---|---|\n| Eggs | 12 |\n\nDone <b>now</b>! _really_";
    expect(prepareSpeechText(md)).toBe("Item, Qty. Eggs, 12. Done now! really.");
  });

  it("returns an empty string for markdown that is only decoration", () => {
    expect(prepareSpeechText("![img](x.png)\n\n---\n")).toBe("");
  });
});

describe("splitSentences", () => {
  it("splits on terminal punctuation but keeps abbreviations, decimals, and quotes together", () => {
    expect(splitSentences('Call Dr. Lee. It costs 3.50 dollars! "Really?" she asked. Ok')).toEqual([
      "Call Dr. Lee.",
      "It costs 3.50 dollars!",
      '"Really?" she asked.',
      "Ok",
    ]);
    expect(splitSentences("e.g. this works. Mr. Smith arrived.")).toEqual(["e.g. this works.", "Mr. Smith arrived."]);
  });
});

describe("SentenceChunker", () => {
  it("emits sentences as deltas complete them and merges short lead-ins", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Sure.")).toEqual([]);
    expect(chunker.push(" I can help wi")).toEqual([]);
    expect(chunker.push("th that. Your appointment is at")).toEqual(["Sure. I can help with that."]);
    expect(chunker.push(" three. See you")).toEqual(["Your appointment is at three."]);
    expect(chunker.flush()).toEqual(["See you"]);
    expect(chunker.flush()).toEqual([]);
  });

  it("holds a terminal-looking tail until whitespace or flush proves it complete", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("First sentence here. It costs 3.")).toEqual(["First sentence here."]);
    expect(chunker.push("50 dollars. ")).toEqual(["It costs 3.50 dollars."]);
    expect(chunker.push("Second one too!")).toEqual([]);
    expect(chunker.flush()).toEqual(["Second one too!"]);
  });

  it("cuts a runaway sentence at a clause boundary", () => {
    const chunker = new SentenceChunker();
    const long = `${"word ".repeat(40)}, ${"more ".repeat(30)}`;
    const out = chunker.push(long);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBeLessThanOrEqual(281);
    expect(out[0].endsWith(",")).toBe(true);
  });
});
