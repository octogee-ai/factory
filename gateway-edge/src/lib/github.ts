import { logger } from "../middleware/logging.js";

const GITHUB_API = "https://api.github.com";
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function githubContentsUrl(owner: string, repo: string, path: string): string {
  if (!OWNER_RE.test(owner)) throw new Error(`Invalid GitHub owner: ${owner}`);
  if (!REPO_RE.test(repo)) throw new Error(`Invalid GitHub repo: ${repo}`);
  const suffix = path ? `/${path}` : "";
  return `${GITHUB_API}/repos/${owner}/${repo}/contents${suffix}`;
}

export function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "octogee-workspace",
  };
}

export function isOversizeFile(file: { encoding?: string }): boolean {
  return file.encoding === "none";
}

export async function githubContentsApi(
  owner: string,
  repo: string,
  path: string,
  token: string | undefined,
): Promise<unknown> {
  const url = githubContentsUrl(owner, repo, path);
  const resp = await fetch(url, { headers: githubHeaders(token) });
  if (!resp.ok) {
    if (resp.status === 404) throw new Error("GitHub API 404");
    const text = await resp.text().catch(() => "");
    logger.error(`GitHub API error: ${resp.status} GET ${url}`, {
      response: text.slice(0, 500),
    });
    throw new Error(`GitHub API ${resp.status}`);
  }
  return resp.json();
}

export interface GithubRepoSummary {
  owner: string;
  repo: string;
  fullName: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
}

interface GithubRepoRaw {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  owner: { login: string };
}

export const GITHUB_REPOS_PAGE = 100;
export const GITHUB_REPOS_MAX_PAGES = 10;

export function githubReposUrl(page = 1): string {
  return `${GITHUB_API}/user/repos?per_page=${GITHUB_REPOS_PAGE}&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`;
}

export function toRepoSummary(r: GithubRepoRaw): GithubRepoSummary {
  return {
    owner: r.owner.login,
    repo: r.name,
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    updatedAt: r.updated_at,
  };
}

export async function githubListRepos(
  token: string,
): Promise<{ repos: GithubRepoSummary[]; truncated: boolean }> {
  const repos: GithubRepoSummary[] = [];
  let page = 1;
  for (; page <= GITHUB_REPOS_MAX_PAGES; page++) {
    const resp = await fetch(githubReposUrl(page), { headers: githubHeaders(token) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.error(`GitHub repos-list error: ${resp.status}`, { response: text.slice(0, 500) });
      throw new Error(`GitHub API ${resp.status}`);
    }
    const raw = (await resp.json()) as GithubRepoRaw[];
    repos.push(...raw.map(toRepoSummary));
    if (raw.length < GITHUB_REPOS_PAGE) break;
  }
  return { repos, truncated: page > GITHUB_REPOS_MAX_PAGES };
}

export function isValidGithubRepoSource(
  rs: unknown,
): rs is { provider: "github"; owner: string; repo: string } {
  if (!rs || typeof rs !== "object") return false;
  const r = rs as { provider?: unknown; owner?: unknown; repo?: unknown };
  return (
    r.provider === "github" &&
    typeof r.owner === "string" &&
    OWNER_RE.test(r.owner) &&
    typeof r.repo === "string" &&
    REPO_RE.test(r.repo)
  );
}
