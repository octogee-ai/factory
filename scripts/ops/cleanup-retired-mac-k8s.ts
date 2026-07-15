import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SECRET_NAME = "mattermost-gateway";
const RETIRED_SECRET_KEYS = ["bot_token", "bot_user_id"] as const;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type RunCommand = (command: string, args: string[]) => CommandResult;

function defaultRun(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function planRetiredMacSecretKeys(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  return RETIRED_SECRET_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
}

export function runRetiredMacK8sCleanup(options: {
  namespace: string;
  apply: boolean;
  run?: RunCommand;
}): { removedKeys: string[]; applied: boolean } {
  if (!NAMESPACE_PATTERN.test(options.namespace)) throw new Error(`invalid namespace: ${options.namespace}`);
  const run = options.run ?? defaultRun;
  const read = run("kubectl", ["get", "secret", SECRET_NAME, "-n", options.namespace, "-o", "json"]);
  if (read.status !== 0) throw new Error(`unable to read ${options.namespace}/${SECRET_NAME}`);
  const secret = JSON.parse(read.stdout) as { data?: unknown };
  const removedKeys = planRetiredMacSecretKeys(secret.data);
  if (options.apply && removedKeys.length > 0) {
    const patch = removedKeys.map((key) => ({ op: "remove", path: `/data/${key}` }));
    const result = run("kubectl", [
      "patch",
      "secret",
      SECRET_NAME,
      "-n",
      options.namespace,
      "--type=json",
      "--patch",
      JSON.stringify(patch),
    ]);
    if (result.status !== 0) throw new Error(`unable to patch ${options.namespace}/${SECRET_NAME}`);
  }
  return { removedKeys, applied: options.apply && removedKeys.length > 0 };
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): {
  namespace: string;
  apply: boolean;
} {
  const namespaceArg = argv.find((arg) => arg.startsWith("--namespace="));
  const namespace = namespaceArg?.slice("--namespace=".length) || env.K8S_NAMESPACE || "";
  if (!namespace) throw new Error("--namespace is required");
  return { namespace, apply: argv.includes("--apply") };
}

function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  console.log(`[retired-mac-k8s] namespace=${args.namespace} mode=${args.apply ? "APPLY" : "dry-run"}`);
  const result = runRetiredMacK8sCleanup(args);
  for (const key of result.removedKeys) {
    console.log(`${args.apply ? "deleted" : "would delete"} ${SECRET_NAME}.data.${key}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
