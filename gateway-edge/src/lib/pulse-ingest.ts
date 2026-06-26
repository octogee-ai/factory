// Pulse ingestion — turn a repo + date window into a normalized PulseWindow the pure
// engine (pulse-metrics) can score. GitHub today (the dogfood repo is GitHub-backed);
// the FileTarget seam lets Gitea slot in later. Reuses the issues-path github helpers.
import type { FileTarget } from "./fileTarget.js";
import { githubJson, githubRepoUrl } from "./github.js";
import { logger } from "../middleware/logging.js";
import {
  computeDxCore4,
  isRevert,
  type DxCore4,
  type PulsePr,
  type PulseWindow,
  type RevertCommit,
} from "./pulse-metrics.js";

const DAY_MS = 86_400_000;
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface WeekRange {
  since: string;
  until: string;
}

// `weeks` rolling 7-day windows ending at `nowMs`, most-recent first. Pure (takes the
// clock as an arg) so it's deterministic to test.
export function weekRanges(nowMs: number, weeks: number): WeekRange[] {
  const out: WeekRange[] = [];
  for (let i = 0; i < weeks; i += 1) {
    out.push({ since: ymd(nowMs - (i + 1) * 7 * DAY_MS), until: ymd(nowMs - i * 7 * DAY_MS) });
  }
  return out;
}

const MAX_PAGES = 10; // up to 1000 items/window — far beyond a real week

interface GhSearchResp {
  total_count?: number;
  items?: Array<{ title?: string; created_at?: string; closed_at?: string; number?: number; html_url?: string }>;
}

const searchUrl = (q: string, page: number): string =>
  `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;

async function searchCount(token: string | undefined, q: string): Promise<number> {
  const r = (await githubJson("GET", searchUrl(q, 1), token)) as GhSearchResp;
  return r.total_count ?? 0;
}

async function searchItems(token: string | undefined, q: string): Promise<NonNullable<GhSearchResp["items"]>> {
  const items: NonNullable<GhSearchResp["items"]> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const r = (await githubJson("GET", searchUrl(q, page), token)) as GhSearchResp;
    const batch = r.items ?? [];
    items.push(...batch);
    if (batch.length < 100) break;
    if (page === MAX_PAGES) logger.warn(`[pulse] search page cap hit for: ${q}`);
  }
  return items;
}

interface GhCommit {
  html_url?: string;
  commit?: { message?: string };
}

// The commit subjects (first line) for the window — needed for accurate revert detection
// (a direct `Revert "…"` commit has no PR, so PR-title matching misses it).
async function fetchCommits(
  token: string | undefined,
  owner: string,
  repo: string,
  since: string,
  until: string,
): Promise<RevertCommit[]> {
  const out: RevertCommit[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = githubRepoUrl(
      owner,
      repo,
      `/commits?since=${since}T00:00:00Z&until=${until}T00:00:00Z&per_page=100&page=${page}`,
    );
    const batch = (await githubJson("GET", url, token)) as GhCommit[];
    for (const c of batch) {
      out.push({ subject: (c.commit?.message ?? "").split("\n")[0], url: c.html_url ?? "" });
    }
    if (batch.length < 100) break;
  }
  return out;
}

// since/until are YYYY-MM-DD (until exclusive).
export async function fetchGithubWindow(target: FileTarget, since: string, until: string): Promise<PulseWindow> {
  const token = target.githubToken;
  const { org: owner, repoName: repo } = target;
  const range = `${since}..${until}`;
  const [merged, issuesClosed, issuesOpened, commitList] = await Promise.all([
    searchItems(token, `repo:${owner}/${repo} is:pr is:merged merged:${range}`),
    searchCount(token, `repo:${owner}/${repo} is:issue closed:${range}`),
    searchCount(token, `repo:${owner}/${repo} is:issue created:${range}`),
    fetchCommits(token, owner, repo, since, until),
  ]);
  const prs: PulsePr[] = merged.map((p) => ({
    title: p.title ?? "",
    createdAt: p.created_at ?? "",
    // closed_at == merged_at for a merged PR; the search payload omits merged_at.
    mergedAt: p.closed_at ?? "",
    additions: 0,
    deletions: 0,
  }));
  const revertCommits = commitList.filter((c) => isRevert(c.subject));
  return { prs, commits: commitList.length, revertCommits, issuesClosed, issuesOpened };
}

export interface StalePr {
  number: number;
  title: string;
  url: string;
  days: number;
}

export interface BugBacklog {
  openedThisWeek: number;
  closedThisWeek: number;
  openNow: number;
}

export interface PulseReport {
  current: DxCore4;
  previous: DxCore4;
  trendPrs: number[]; // merged PRs per week, oldest → newest (for the sparkline)
  week: WeekRange; // the current window, for display
  reverts: RevertCommit[]; // this week's revert commits (evidence behind the Quality number)
  stalePrs: StalePr[]; // open PRs aging past the threshold (empty = healthy flow)
  bugs: BugBacklog; // bug-labeled inflow vs outflow
}

const STALE_DAYS = 7;

async function fetchStalePrs(target: FileTarget, nowMs: number): Promise<StalePr[]> {
  const items = await searchItems(target.githubToken, `repo:${target.org}/${target.repoName} is:pr is:open`);
  return items
    .map((p) => ({
      number: p.number ?? 0,
      title: p.title ?? "",
      url: p.html_url ?? "",
      days: Math.floor((nowMs - Date.parse(p.created_at ?? "")) / 86_400_000),
    }))
    .filter((p) => Number.isFinite(p.days) && p.days >= STALE_DAYS)
    .sort((a, b) => b.days - a.days);
}

async function fetchBugBacklog(target: FileTarget, since: string, until: string): Promise<BugBacklog> {
  const repo = `repo:${target.org}/${target.repoName}`;
  const range = `${since}..${until}`;
  const [openedThisWeek, closedThisWeek, openNow] = await Promise.all([
    searchCount(target.githubToken, `${repo} is:issue label:bug created:${range}`),
    searchCount(target.githubToken, `${repo} is:issue label:bug closed:${range}`),
    searchCount(target.githubToken, `${repo} is:issue is:open label:bug`),
  ]);
  return { openedThisWeek, closedThisWeek, openNow };
}

// The full report a Pulse surface renders: this week + last week scored, plus a merged-PR
// trend. Reuses the two full windows and adds cheap count-only calls for the older weeks.
export async function fetchPulseReport(target: FileTarget, nowMs: number, trendWeeks = 6): Promise<PulseReport> {
  const ranges = weekRanges(nowMs, Math.max(2, trendWeeks));
  const [curWin, prevWin] = await Promise.all([
    fetchGithubWindow(target, ranges[0].since, ranges[0].until),
    fetchGithubWindow(target, ranges[1].since, ranges[1].until),
  ]);
  const current = computeDxCore4(curWin);
  const previous = computeDxCore4(prevWin);
  const counts = [current.speed.prsMerged, previous.speed.prsMerged];
  for (let i = 2; i < trendWeeks; i += 1) {
    const r = ranges[i];
    const q = `repo:${target.org}/${target.repoName} is:pr is:merged merged:${r.since}..${r.until}`;
    counts.push(await searchCount(target.githubToken, q)); // sequential: stay under the GH search rate limit
  }
  const [stalePrs, bugs] = await Promise.all([
    fetchStalePrs(target, nowMs),
    fetchBugBacklog(target, ranges[0].since, ranges[0].until),
  ]);
  return {
    current,
    previous,
    trendPrs: counts.reverse(),
    week: ranges[0],
    reverts: curWin.revertCommits,
    stalePrs,
    bugs,
  };
}
