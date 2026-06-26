import type { FileTarget } from "./fileTarget.js";
import { giteaApiAsUser } from "./gitea.js";
import {
  githubIssuesApi,
  githubLabelsApi,
  githubJson,
  githubRepoUrl,
  GITHUB_ISSUES_PER_PAGE,
} from "./github.js";
import {
  isPullRequest,
  normalizeIssue,
  normalizeIssues,
  normalizeLabels,
  type WorkspaceIssue,
  type WorkspaceLabel,
} from "./issues-normalize.js";
import { computeMove, labelForColumn, STATUS_LABEL_SEED, type ColumnKey } from "./issues-write.js";
import { logger } from "../middleware/logging.js";

const GITEA_ISSUES_LIMIT = 100;

function giteaSudo(target: FileTarget): string {
  if (!target.sudoUser) throw new Error("gitea issues target missing sudoUser");
  return target.sudoUser;
}

export async function listIssues(target: FileTarget): Promise<WorkspaceIssue[]> {
  const cap = target.provider === "github" ? GITHUB_ISSUES_PER_PAGE : GITEA_ISSUES_LIMIT;
  const raw =
    target.provider === "github"
      ? await githubIssuesApi(target.org, target.repoName, target.githubToken)
      : await giteaApiAsUser(
          giteaSudo(target),
          target.org,
          `${target.repoName}/issues?state=all&type=issues&limit=${GITEA_ISSUES_LIMIT}`,
        );
  if (Array.isArray(raw) && raw.length >= cap) {
    logger.warn(`[issues] page cap ${cap} hit for ${target.org}/${target.repoName} — older issues not loaded`);
  }
  return normalizeIssues(raw);
}

export async function listLabels(target: FileTarget): Promise<WorkspaceLabel[]> {
  const raw =
    target.provider === "github"
      ? await githubLabelsApi(target.org, target.repoName, target.githubToken)
      : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/labels?limit=${GITEA_ISSUES_LIMIT}`);
  return normalizeLabels(raw);
}

// --- Write path ---------------------------------------------------------------
// GitHub applies labels by name; Gitea by numeric id. So writes resolve a name->id
// map (Gitea) and seed the status:* labels if absent (both providers need them to
// exist before a move can apply one). GitHub writes go as the brokered owner token,
// so issue authorship is the owner; Gitea writes are sudo'd as the acting member.

interface RepoLabel {
  id: number;
  name: string;
}

function rawId(raw: unknown): number {
  return Number((raw as { id?: unknown })?.id) || 0;
}

async function loadRepoLabels(target: FileTarget): Promise<RepoLabel[]> {
  const raw =
    target.provider === "github"
      ? await githubLabelsApi(target.org, target.repoName, target.githubToken)
      : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/labels?limit=${GITEA_ISSUES_LIMIT}`);
  return (Array.isArray(raw) ? raw : []).map((l) => ({ id: rawId(l), name: String((l as { name?: unknown }).name ?? "") }));
}

async function ensureStatusLabels(target: FileTarget): Promise<Map<string, number>> {
  const byName = new Map((await loadRepoLabels(target)).map((l) => [l.name, l.id]));
  for (const seed of STATUS_LABEL_SEED) {
    if (byName.has(seed.name)) continue;
    const created =
      target.provider === "github"
        ? await githubJson("POST", githubRepoUrl(target.org, target.repoName, "/labels"), target.githubToken, seed)
        : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/labels`, "POST", seed);
    byName.set(seed.name, rawId(created));
  }
  return byName;
}

// On GitHub (and Gitea) a pull request shares the issue-number space and is reachable
// at /issues/:n. The Board never shows PRs (the read path filters them) and a write must
// never touch one — so reject before any label/state mutation.
export class NotAnIssueError extends Error {
  constructor(num: number) {
    super(`#${num} is a pull request, not an issue`);
    this.name = "NotAnIssueError";
  }
}

async function getIssue(target: FileTarget, num: number): Promise<WorkspaceIssue> {
  const raw =
    target.provider === "github"
      ? await githubJson("GET", githubRepoUrl(target.org, target.repoName, `/issues/${num}`), target.githubToken)
      : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}`);
  if (isPullRequest(raw)) throw new NotAnIssueError(num);
  return normalizeIssue(raw);
}

async function removeLabel(target: FileTarget, num: number, name: string, map: Map<string, number>): Promise<void> {
  if (target.provider === "github") {
    await githubJson(
      "DELETE",
      githubRepoUrl(target.org, target.repoName, `/issues/${num}/labels/${encodeURIComponent(name)}`),
      target.githubToken,
    );
    return;
  }
  const id = map.get(name);
  if (id == null) return;
  await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}/labels/${id}`, "DELETE");
}

async function addLabel(target: FileTarget, num: number, name: string, map: Map<string, number>): Promise<void> {
  if (target.provider === "github") {
    await githubJson("POST", githubRepoUrl(target.org, target.repoName, `/issues/${num}/labels`), target.githubToken, {
      labels: [name],
    });
    return;
  }
  const id = map.get(name);
  if (id == null) return;
  await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}/labels`, "POST", { labels: [id] });
}

async function setIssueState(target: FileTarget, num: number, state: "open" | "closed"): Promise<void> {
  if (target.provider === "github") {
    await githubJson("PATCH", githubRepoUrl(target.org, target.repoName, `/issues/${num}`), target.githubToken, { state });
    return;
  }
  await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}`, "PATCH", { state });
}

export interface CreateIssueInput {
  title: string;
  body: string;
  status: ColumnKey;
}

export async function createIssue(target: FileTarget, input: CreateIssueInput): Promise<WorkspaceIssue> {
  const labelName = labelForColumn(input.status);
  const id = labelName ? (await ensureStatusLabels(target)).get(labelName) : undefined;
  if (target.provider === "github") {
    const raw = await githubJson("POST", githubRepoUrl(target.org, target.repoName, "/issues"), target.githubToken, {
      title: input.title,
      body: input.body,
      ...(labelName ? { labels: [labelName] } : {}),
    });
    return normalizeIssue(raw);
  }
  const raw = await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues`, "POST", {
    title: input.title,
    body: input.body,
    ...(id ? { labels: [id] } : {}),
  });
  return normalizeIssue(raw);
}

export async function moveIssue(target: FileTarget, num: number, status: ColumnKey): Promise<WorkspaceIssue> {
  const issue = await getIssue(target, num);
  const plan = computeMove(issue.labels, status);
  const map = await ensureStatusLabels(target);
  await Promise.all(plan.remove.map((name) => removeLabel(target, num, name, map)));
  if (plan.add) await addLabel(target, num, plan.add, map);
  if (issue.state !== plan.state) await setIssueState(target, num, plan.state);
  return getIssue(target, num);
}
