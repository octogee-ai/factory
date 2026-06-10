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
