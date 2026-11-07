export const DENY_LIST_MODULE = "scripts/lib/factory-deny-list.ts";

export interface DenyRule {
  name: string;
  pattern: RegExp;
}

export interface DenyHit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

export const DENY_LIST: readonly DenyRule[] = [
  { name: "personal email", pattern: /@(?!octogee\.com\b)[a-z0-9-]+\.[a-z]{2,}/i },
  { name: "company domain", pattern: /squarepointconsulting/i },
  { name: "GCP project number", pattern: /94934561284/ },
  { name: "service account", pattern: /iam\.gserviceaccount\.com/i },
  { name: "TEST environment identity", pattern: /octogee-test|-test\.octogee\.com|\bgke_/i },
  { name: "admin host", pattern: /admin\.octogee/i },
  { name: "monitoring host", pattern: /monitoring\.octogee/i },
  { name: "partner or portfolio name", pattern: /seven peaks|mountain mama|wild card|\bhobin\b|nucrew/i },
  { name: "partner or portfolio name", pattern: /\bDan\b|\bTheos?\b|\bStudio\b/ },
  { name: "Stripe", pattern: /\bstripe\b/i },
  { name: "markup", pattern: /\bmarkups?\b/i },
  { name: "margin", pattern: /\bmargins?\b/i },
  { name: "trial", pattern: /\btrials?\b/i },
  { name: "price", pattern: /\$\d|\b\d[\d,]*(?:\.\d+)? ?(?:usd|eur|gbp)\b|\/mo(?:nth)?\b/i },
];

export function denyListHits(files: ReadonlyMap<string, string>): DenyHit[] {
  const hits: DenyHit[] = [];
  for (const [file, content] of files) {
    if (file === DENY_LIST_MODULE) continue;
    content.split("\n").forEach((text, index) => {
      for (const rule of DENY_LIST) {
        const match = rule.pattern.exec(text);
        if (match) hits.push({ file, line: index + 1, rule: rule.name, text: match[0] });
      }
    });
  }
  return hits;
}

export function formatRefusal(hits: readonly DenyHit[]): string {
  const lines = hits.map(hit => `  ${hit.file}:${hit.line} ${hit.rule}: ${JSON.stringify(hit.text)}`);
  return `publish refused by the deny list (${hits.length} hits):\n${lines.join("\n")}`;
}
