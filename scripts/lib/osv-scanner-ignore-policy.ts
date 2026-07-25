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

const ENTRY_BLOCK_PATTERN = /\[\[IgnoredVulns\]\]([^[]*)/g;
const ID_PATTERN = /^\s*id\s*=\s*"([^"]*)"/m;
const IGNORE_UNTIL_PATTERN = /^\s*ignoreUntil\s*=\s*(\d{4}-\d{2}-\d{2})/m;
const REASON_PATTERN = /^\s*reason\s*=\s*"([^"]*)"/m;
const ISSUE_REFERENCE_PATTERN = /#\d+/;

export function parseIgnoredVulns(tomlContent: string): Partial<IgnoredVulnEntry>[] {
  const entries: Partial<IgnoredVulnEntry>[] = [];

  for (const match of tomlContent.matchAll(ENTRY_BLOCK_PATTERN)) {
    const block = match[1];
    const entry: Partial<IgnoredVulnEntry> = {};

    const id = block.match(ID_PATTERN);
    if (id) entry.id = id[1];

    const ignoreUntil = block.match(IGNORE_UNTIL_PATTERN);
    if (ignoreUntil) entry.ignoreUntil = ignoreUntil[1];

    const reason = block.match(REASON_PATTERN);
    if (reason) entry.reason = reason[1];

    entries.push(entry);
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
