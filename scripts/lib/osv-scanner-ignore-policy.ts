export interface IgnoredVulnEntry {
  id: string;
  ignoreUntil: string;
  reason: string;
}

export interface IgnorePolicyViolation {
  entry: Partial<IgnoredVulnEntry>;
  message: string;
}

export const MAX_IGNORE_WINDOW_DAYS = 60;

const ENTRY_MARKER = "[[IgnoredVulns]]";
const TABLE_MARKER = "[[";
const ISSUE_REFERENCE_PATTERN = /#\d+/;

function extractRawValue(block: string, key: string): string | undefined {
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(key)) continue;

    const afterKey = line.slice(key.length).trimStart();
    if (!afterKey.startsWith("=")) continue;

    return afterKey.slice(1).trim();
  }

  return undefined;
}

function unquote(rawValue: string): string | undefined {
  if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1);
  }

  return undefined;
}

function isAllDigits(value: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }

  return true;
}

function isIsoDateShape(value: string): boolean {
  return (
    value.length === 10 &&
    value.charAt(4) === "-" &&
    value.charAt(7) === "-" &&
    isAllDigits(value, 0, 4) &&
    isAllDigits(value, 5, 7) &&
    isAllDigits(value, 8, 10)
  );
}

function parseEntryBlock(block: string): Partial<IgnoredVulnEntry> {
  const entry: Partial<IgnoredVulnEntry> = {};

  const id = extractRawValue(block, "id");
  if (id !== undefined) {
    const unquoted = unquote(id);
    if (unquoted !== undefined) entry.id = unquoted;
  }

  const ignoreUntil = extractRawValue(block, "ignoreUntil");
  if (ignoreUntil !== undefined && isIsoDateShape(ignoreUntil)) {
    entry.ignoreUntil = ignoreUntil;
  }

  const reason = extractRawValue(block, "reason");
  if (reason !== undefined) {
    const unquoted = unquote(reason);
    if (unquoted !== undefined) entry.reason = unquoted;
  }

  return entry;
}

export function parseIgnoredVulns(tomlContent: string): Partial<IgnoredVulnEntry>[] {
  const entries: Partial<IgnoredVulnEntry>[] = [];
  let searchFrom = 0;

  for (;;) {
    const start = tomlContent.indexOf(ENTRY_MARKER, searchFrom);
    if (start === -1) break;

    const blockStart = start + ENTRY_MARKER.length;
    const nextMarker = tomlContent.indexOf(TABLE_MARKER, blockStart);
    const blockEnd = nextMarker === -1 ? tomlContent.length : nextMarker;

    entries.push(parseEntryBlock(tomlContent.slice(blockStart, blockEnd)));
    searchFrom = blockEnd;
  }

  return entries;
}

export function validateIgnoredVulnEntry(
  entry: Partial<IgnoredVulnEntry>,
  referenceDate: Date,
): IgnorePolicyViolation[] {
  const violations: IgnorePolicyViolation[] = [];

  if (!entry.id) {
    violations.push({ entry, message: "entry is missing a required id" });
  }

  if (!entry.ignoreUntil) {
    violations.push({ entry, message: "entry is missing a required ignoreUntil date" });
  } else {
    const ignoreUntilDate = new Date(`${entry.ignoreUntil}T00:00:00Z`);
    if (Number.isNaN(ignoreUntilDate.getTime())) {
      violations.push({ entry, message: `ignoreUntil "${entry.ignoreUntil}" is not a valid date` });
    } else {
      const maxAllowed = new Date(referenceDate);
      maxAllowed.setUTCDate(maxAllowed.getUTCDate() + MAX_IGNORE_WINDOW_DAYS);
      if (ignoreUntilDate.getTime() > maxAllowed.getTime()) {
        violations.push({
          entry,
          message: `ignoreUntil "${entry.ignoreUntil}" is more than ${MAX_IGNORE_WINDOW_DAYS} days past the reference date`,
        });
      }
    }
  }

  if (!entry.reason) {
    violations.push({ entry, message: "entry is missing a required reason" });
  } else if (!ISSUE_REFERENCE_PATTERN.test(entry.reason)) {
    violations.push({ entry, message: "entry's reason is missing an issue reference (e.g. #1234)" });
  }

  return violations;
}

export function validateIgnorePolicyFile(
  tomlContent: string,
  referenceDate: Date = new Date(),
): IgnorePolicyViolation[] {
  return parseIgnoredVulns(tomlContent).flatMap((entry) =>
    validateIgnoredVulnEntry(entry, referenceDate),
  );
}
