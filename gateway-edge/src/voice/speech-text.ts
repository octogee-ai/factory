const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`\n]*)`/g;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const HEADING_RE = /^#{1,6} +/;
const BLOCKQUOTE_RE = /^> ?/;
const LIST_MARKER_RE = /^(?:[-*+•]|\d+[.)]) +/;
const HORIZONTAL_RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const EMPHASIS_RE = /(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const MULTI_SPACE_RE = /[ \t]{2,}/g;
const TERMINAL_PUNCTUATION_RE = /[.!?:;,]$/;

function stripLinks(text: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("[", cursor);
    if (open === -1) break;
    const close = text.indexOf("]", open + 1);
    if (close === -1) break;
    const parenClose = text[close + 1] === "(" ? text.indexOf(")", close + 2) : -1;
    if (parenClose === -1) {
      out += text.slice(cursor, close + 1);
      cursor = close + 1;
      continue;
    }
    out += text.slice(cursor, open) + text.slice(open + 1, close);
    cursor = parenClose + 1;
  }
  return out + text.slice(cursor);
}

function stripDirectives(text: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("[[", cursor);
    if (open === -1) break;
    const close = text.indexOf("]]", open + 2);
    if (close === -1) break;
    out += text.slice(cursor, open);
    cursor = close + 2;
  }
  return out + text.slice(cursor);
}

function isTableRule(line: string): boolean {
  if (!line.includes("-")) return false;
  for (const ch of line) {
    if (ch !== "|" && ch !== "-" && ch !== ":" && ch !== " ") return false;
  }
  return true;
}

function spokenTableRow(line: string): string {
  const cells = line.slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean);
  return cells.length ? `${cells.join(", ")}.` : "";
}

function spokenLine(rawLine: string): string {
  let line = rawLine.trim();
  if (!line || HORIZONTAL_RULE_RE.test(line)) return "";
  if (line.startsWith("|") && line.endsWith("|") && line.length > 1) {
    return isTableRule(line) ? "" : spokenTableRow(line);
  }
  line = line.replace(HEADING_RE, "").replace(BLOCKQUOTE_RE, "").replace(LIST_MARKER_RE, "").trim();
  if (!line) return "";
  return TERMINAL_PUNCTUATION_RE.test(line) ? line : `${line}.`;
}

/**
 * Turn assistant markdown into something a voice should say. Structure that
 * carries no meaning aloud (fences, links, tags, emphasis markers, emoji) is
 * dropped or replaced with a spoken stand-in; line structure becomes sentence
 * pauses so lists don't run together.
 */
export function prepareSpeechText(markdown: string): string {
  const inline = stripDirectives(
    stripLinks(
      markdown
        .replace(/\r\n?/g, "\n")
        .replace(CODE_BLOCK_RE, " (code omitted) ")
        .replace(INLINE_CODE_RE, "$1")
        .replace(IMAGE_RE, ""),
    ).replace(BARE_URL_RE, "a link"),
  )
    .replace(HTML_TAG_RE, " ")
    .replace(EMPHASIS_RE, "$2")
    .replace(EMOJI_RE, "");
  return inline
    .split("\n")
    .map(spokenLine)
    .filter(Boolean)
    .join(" ")
    .replace(MULTI_SPACE_RE, " ")
    .replace(/ +([.!?:;,])/g, "$1")
    .trim();
}

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "no", "inc", "ltd", "co", "mt", "ft",
]);
const CLOSERS = new Set(['"', "'", ")", "]"]);
const TERMINALS = new Set([".", "!", "?"]);

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function endsWithAbbreviation(candidate: string): boolean {
  const lastSpace = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"), candidate.lastIndexOf("\t"));
  const word = candidate.slice(lastSpace + 1).toLowerCase().replace(/\.$/, "");
  return ABBREVIATIONS.has(word) || /^[a-z]$/.test(word);
}

function decimalContinues(text: string, candidate: string, after: number): boolean {
  return /\d\.$/.test(candidate) && /^\d/.test(text.slice(after));
}

/** Index just past the closing quotes/brackets that hug a terminal mark. */
function skipClosers(text: string, from: number): number {
  let j = from;
  while (j < text.length && CLOSERS.has(text[j])) j++;
  return j;
}

function nextNonSpaceIsLower(text: string, from: number): boolean {
  let k = from;
  while (k < text.length && isWhitespace(text[k])) k++;
  return k < text.length && /\p{Ll}/u.test(text[k]);
}

function sentenceBoundaryAfter(text: string, terminalAt: number, start: number): number | null {
  const after = skipClosers(text, terminalAt + 1);
  if (after < text.length && !isWhitespace(text[after])) return null;
  if (nextNonSpaceIsLower(text, after)) return null;
  if (text[terminalAt] === ".") {
    const candidate = text.slice(start, after).trim();
    if (decimalContinues(text, candidate, after) || endsWithAbbreviation(candidate)) return null;
  }
  return after;
}

/**
 * Split text into sentences at terminal punctuation followed by whitespace,
 * keeping abbreviations and decimals together. Trailing text without terminal
 * punctuation is returned as the last element.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const boundary = TERMINALS.has(text[i]) ? sentenceBoundaryAfter(text, i, start) : null;
    if (boundary === null) {
      i += 1;
      continue;
    }
    const sentence = text.slice(start, boundary).trim();
    if (sentence) out.push(sentence);
    start = boundary;
    i = boundary;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

export const SENTENCE_CHUNK_MIN_CHARS = 12;
export const SENTENCE_CHUNK_MAX_CHARS = 280;
const ENDS_COMPLETE_RE = /[.!?]["')\]]*\s+$/;

/**
 * Streaming sentence assembler for TTS pipelining: feed assistant text deltas,
 * receive speakable sentences as soon as they complete. Very short first
 * fragments ("Sure.") are merged into the following sentence so the voice does
 * not stutter, and runaway sentences are cut at a clause boundary.
 */
export class SentenceChunker {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const sentences = splitSentences(this.buffer);
    if (sentences.length === 0) return [];
    const endsComplete = ENDS_COMPLETE_RE.test(this.buffer);
    const complete = endsComplete ? sentences : sentences.slice(0, -1);
    const tail = endsComplete ? "" : sentences[sentences.length - 1];
    if (complete.length === 0) return this.spillIfLong();
    const merged = mergeShortSentences(complete);
    const last = merged[merged.length - 1];
    const held = last !== undefined && last.length < SENTENCE_CHUNK_MIN_CHARS ? merged.pop() ?? "" : "";
    this.buffer = held ? `${held} ${tail}`.trim() : tail;
    return merged;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  private spillIfLong(): string[] {
    if (this.buffer.length < SENTENCE_CHUNK_MAX_CHARS) return [];
    const cut = this.buffer.lastIndexOf(", ", SENTENCE_CHUNK_MAX_CHARS);
    if (cut < SENTENCE_CHUNK_MIN_CHARS) return [];
    const head = this.buffer.slice(0, cut + 1).trim();
    this.buffer = this.buffer.slice(cut + 1);
    return [head];
  }
}

function mergeShortSentences(sentences: string[]): string[] {
  const out: string[] = [];
  for (const sentence of sentences) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length < SENTENCE_CHUNK_MIN_CHARS) {
      out[out.length - 1] = `${last} ${sentence}`;
    } else {
      out.push(sentence);
    }
  }
  return out;
}
