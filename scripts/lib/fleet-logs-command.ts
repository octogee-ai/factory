import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { type FleetLogsOptions, type FleetLogLine, buildFleetLogsFilter, createFleetLogsParser, fleetLogsTailArgs, FLEET_LOGS_TAIL_ENV, matchesFleetLog, normalizeFleetLog, parseFleetLogsOptions, renderFleetLogLine } from "./fleet-logs.js";

function startLogTransport(options: FleetLogsOptions, diagnostics: Writable) {
  const target = deploymentEnvironmentSettings(options.environment);
  const filter = buildFleetLogsFilter({ namespace: target.namespace, gatewayId: options.gatewayId, container: options.container, migrationId: options.migrationId });
  const gcloudArgs = options.follow
    ? fleetLogsTailArgs({ projectId: target.clusterProjectId, filter, bufferWindow: options.bufferWindow })
    : ["logging", "read", filter, `--project=${target.clusterProjectId}`, `--freshness=${options.since ?? "10m"}`, `--limit=${options.limit}`, "--order=desc", "--format=json"];
  const mode = options.follow ? "live" : `recent ${options.since ?? "10m"}`;
  diagnostics.write(`fleet logs ${options.environment} · ${new Date().toISOString()} · ${mode} · level=${options.levelExact?.join(",") ?? options.level}\n`);
  if (options.builders) diagnostics.write("Builder filter matches explicit builderSlug fields and dedicated VM labels; untagged events are excluded.\n");
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- gcloud is the authenticated operator CLI.
  return spawn("gcloud", gcloudArgs, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...FLEET_LOGS_TAIL_ENV } });
}

async function readLogEntries(source: AsyncIterable<Buffer>, options: FleetLogsOptions, write: (entry: FleetLogLine) => Promise<void>, stopped: () => boolean) {
  let scanned = 0;
  const recent: FleetLogLine[] = [];
  let entries: unknown[] = [];
  const parser = createFleetLogsParser(entry => entries.push(entry));
  for await (const chunk of source) {
    if (stopped()) break;
    parser.write(chunk);
    for (const value of entries) {
      scanned++;
      const entry = normalizeFleetLog(value);
      if (!matchesFleetLog(entry, options)) continue;
      if (options.follow) await write(entry);
      else recent.push(entry);
    }
    entries = [];
  }
  return { scanned, recent, parser };
}

function outputColor(options: FleetLogsOptions): boolean {
  return options.color === "always" || (options.color === "auto" && process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
}

function checkExit(exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error }, follow: boolean): void {
  if (exit.error) throw exit.error;
  if (exit.code !== 0) throw new Error(`gcloud logging ${follow ? "tail" : "read"} exited ${exit.code ?? exit.signal}; see diagnostics above`);
}

export async function runFleetLogsCommand(argv: string[], output: Writable = process.stdout, diagnostics: Writable = process.stderr): Promise<void> {
  const options = parseFleetLogsOptions(argv);
  const color = outputColor(options);
  const child = startLogTransport(options, diagnostics);
  child.stderr.pipe(diagnostics, { end: false });
  let stopped = false;
  let outputError: Error | undefined;
  const stop = () => { stopped = true; child.kill("SIGTERM"); };
  const onOutputError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") outputError = error;
    stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  output.on("error", onOutputError);
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
    child.once("error", error => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let shown = 0;
  const write = async (entry: ReturnType<typeof normalizeFleetLog>) => {
    const line = options.format === "json" ? JSON.stringify(entry) : renderFleetLogLine(entry, { color, timestamps: options.timestamps });
    await new Promise<void>((resolve, reject) => output.write(line + "\n", error => error ? reject(error) : resolve()));
    shown++;
  };
  try {
    const { scanned, recent, parser } = await readLogEntries(child.stdout, options, write, () => stopped);
    const exit = await completion;
    if (outputError) throw outputError;
    if (stopped) return;
    checkExit(exit, options.follow);
    if (!parser.isEnded) parser.end();
    for (const entry of recent.reverse()) await write(entry);
    if (!options.follow) diagnostics.write(`Shown ${shown} of ${scanned} fetched records${scanned === options.limit ? "; fetch limit reached, increase --limit to search further" : ""}.\n`);
  } catch (error) {
    if (!stopped || outputError) throw error;
  } finally {
    child.kill("SIGTERM");
    const killDeadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
    killDeadline.unref();
    await completion;
    clearTimeout(killDeadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    output.removeListener("error", onOutputError);
    child.stderr.unpipe(diagnostics);
  }
}
