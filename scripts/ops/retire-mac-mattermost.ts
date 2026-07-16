import { mmApiCallStrict } from "@octogee/core/mattermost/client";
import { pathToFileURL } from "node:url";

const CENTRAL_MAC_USERNAMES = ["mac-gw-prod", "mac-gw-test"] as const;
const USERNAME_PATTERN = /^mac-[a-z0-9][a-z0-9-]{0,62}$/;
const GATEWAY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface RetireMacMattermostArgs {
  apply: boolean;
  usernames: string[];
}

function repeatedFlag(argv: string[], name: string): string[] {
  return argv
    .filter((arg) => arg.startsWith(`${name}=`))
    .map((arg) => arg.slice(name.length + 1));
}

export function parseRetireMacMattermostArgs(
  argv: string[],
  _env: NodeJS.ProcessEnv = process.env,
): RetireMacMattermostArgs {
  const gateways = repeatedFlag(argv, "--gateway");
  for (const gateway of gateways) {
    if (!GATEWAY_PATTERN.test(gateway)) throw new Error(`invalid gateway id: ${gateway}`);
  }
  const explicit = repeatedFlag(argv, "--username");
  const usernames = [...new Set([
    ...CENTRAL_MAC_USERNAMES,
    ...gateways.map((gateway) => `mac-${gateway}`),
    ...explicit,
  ])].sort();
  for (const username of usernames) {
    if (!USERNAME_PATTERN.test(username)) throw new Error(`invalid historical Mac username: ${username}`);
  }
  return { apply: argv.includes("--apply"), usernames };
}

interface MattermostUser {
  id?: unknown;
  username?: unknown;
  is_bot?: unknown;
  delete_at?: unknown;
}

type MmApiCall = (method: string, endpoint: string, body?: unknown) => Promise<unknown>;

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { status?: unknown }).status === 404;
}

export async function retireMacMattermostUser(options: {
  username: string;
  apply: boolean;
  mmApiCall?: MmApiCall;
}): Promise<{
  outcome: "missing" | "planned" | "retired";
  username: string;
  tokenCount: number;
  wasActive: boolean;
}> {
  if (!USERNAME_PATTERN.test(options.username)) {
    throw new Error(`invalid historical Mac username: ${options.username}`);
  }
  const call = options.mmApiCall ?? mmApiCallStrict;
  let user: MattermostUser | null;
  try {
    user = await call("GET", `/users/username/${options.username}`) as MattermostUser | null;
  } catch (error) {
    if (isNotFound(error)) {
      return { outcome: "missing", username: options.username, tokenCount: 0, wasActive: false };
    }
    throw error;
  }
  if (!user) return { outcome: "missing", username: options.username, tokenCount: 0, wasActive: false };
  if (user.username !== options.username) throw new Error(`Mattermost returned a mismatched user for ${options.username}`);
  if (user.is_bot !== true) throw new Error(`refusing to retire ${options.username}: account is not a bot`);
  if (typeof user.id !== "string" || user.id.length === 0) {
    throw new Error(`Mattermost bot ${options.username} has no user id`);
  }
  const tokens = await call("GET", `/users/${user.id}/tokens`);
  if (!Array.isArray(tokens) || !tokens.every((token) =>
    typeof token === "object" && token !== null && typeof (token as { id?: unknown }).id === "string")) {
    throw new Error(`Mattermost returned an invalid token list for ${options.username}`);
  }
  const wasActive = user.delete_at === undefined || user.delete_at === 0;
  if (!options.apply) {
    return { outcome: "planned", username: options.username, tokenCount: tokens.length, wasActive };
  }
  for (const token of tokens) {
    await call("POST", "/users/tokens/revoke", {
      token_id: (token as { id: string }).id,
    });
  }
  if (wasActive) await call("PUT", `/users/${user.id}/active`, { active: false });
  return { outcome: "retired", username: options.username, tokenCount: tokens.length, wasActive };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseRetireMacMattermostArgs(argv);
  if (!process.env.MM_URL || !process.env.MM_ADMIN_TOKEN) {
    throw new Error("MM_URL and MM_ADMIN_TOKEN are required");
  }
  console.log(`[retire-mac-mattermost] mode=${args.apply ? "APPLY" : "dry-run"}`);
  for (const username of args.usernames) {
    const result = await retireMacMattermostUser({ username, apply: args.apply });
    console.log(`${result.outcome} ${username} tokens=${result.tokenCount} active=${result.wasActive}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
