#!/usr/bin/env node
// Render the stock OpenClaw lane's results: stock-openclaw-summary.mjs report | tail <log-dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { redactSecrets } from "../ops/kind-isolated-gateway.mjs";
import { STEPS } from "../ops/kind-stock-openclaw.mjs";

export const STAGES = [
  { job: "package", step: "resolve", title: "Find the upstream OpenClaw commit the pinned overlay is based on" },
  { job: "package", step: "install", title: "Install that commit's dependencies" },
  { job: "package", step: "build", title: "Build OpenClaw (`pnpm build:package`)" },
  { job: "package", step: "pack", title: "Pack the core and Mattermost packages, checking the platform's plugin contracts" },
  { job: "kind", step: "install", title: "Build the gateway images from those packages and install the platform on kind" },
];

const TAIL_LINES = 40;
const RESULT = { success: "passed", failure: "failed", cancelled: "cancelled", skipped: "skipped" };

const cell = text => String(text ?? "").split("\n").map(line => line.trim()).join(" ").replace(/\|/g, "\\|");
const short = sha => `\`${sha.slice(0, 8)}\``;

function stageRows(needs) {
  return STAGES.map(stage => {
    const outcome = needs[stage.job]?.outputs?.[stage.step];
    return { title: stage.title, status: RESULT[outcome] ?? "skipped" };
  });
}

function kindRows(needs, install) {
  const raw = needs.kind?.outputs?.report;
  if (!raw) {
    const status = install === "passed" ? "failed" : "skipped";
    const detail = install === "passed" ? "The steps on kind did not report a result" : "";
    return STEPS.map((step, index) => ({ title: step.title, status: index === 0 ? status : "skipped", detail: index === 0 ? detail : "" }));
  }
  const { steps } = JSON.parse(raw);
  return STEPS.map(step => {
    const found = steps.find(entry => entry.id === step.id);
    if (!found) return { title: step.title, status: "failed", detail: "Missing from the report" };
    return { title: step.title, status: found.status, detail: found.detail ?? found.note ?? "", seconds: found.seconds };
  });
}

function source(outputs) {
  if (!(outputs.base && outputs.overlay && outputs.upstream && outputs.fork)) return [];
  const version = outputs.version ? ` (version ${outputs.version})` : "";
  const upstream = `[${short(outputs.base)}](https://github.com/${outputs.upstream}/commit/${outputs.base})`;
  const overlay = `[${short(outputs.overlay)}](https://github.com/${outputs.fork}/commit/${outputs.overlay})`;
  return [`Upstream OpenClaw ${upstream}${version}, without the ${outputs.commits} overlay commits that end at ${overlay}, the pinned build.`, ""];
}

function verdict(failed, notRequested) {
  if (failed.length) return `First failure: ${failed[0].title}. The failing job's summary below has the end of its log. This lane does not block the build.`;
  return `${notRequested ? "Every step that ran passed" : "Every step passed"}. This lane does not block the build.`;
}

export function report(needs) {
  const stages = stageRows(needs);
  const notRequested = stages[3].status === "passed" && needs.kind?.result === "skipped";
  const rows = notRequested
    ? [...stages.slice(0, -1), ...[stages.at(-1), ...STEPS].map(row => ({ title: row.title, status: "not run" }))]
    : [...stages, ...kindRows(needs, stages.at(-1).status)];
  const lines = ["### Fleet features on stock OpenClaw", "", ...source(needs.package?.outputs ?? {})];
  if (notRequested) lines.push("This run built the stock packages only. Build main runs the kind steps on `main`.", "");
  lines.push("| Step | Result | Detail |", "| --- | --- | --- |");
  for (const row of rows) {
    const time = row.seconds === undefined ? "" : ` (${row.seconds}s)`;
    lines.push(`| ${cell(row.title)} | ${row.status}${time} | ${cell(redactSecrets(row.detail ?? ""))} |`);
  }
  const failed = rows.filter(row => row.status === "failed");
  lines.push("", verdict(failed, notRequested));
  return { markdown: lines.join("\n") + "\n", failed: failed.length };
}

export function tails(steps, logDir) {
  const sections = [];
  for (const [id, step] of Object.entries(steps)) {
    if (step.outcome !== "failure") continue;
    const file = join(logDir, `${id}.log`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").slice(-TAIL_LINES);
    sections.push(`#### The last ${lines.length} lines of \`${id}\``, "", "```text", redactSecrets(lines.join("\n")).replace(/```/g, "'''"), "```", "");
  }
  return sections.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, logDir] = process.argv.slice(2);
  if (mode === "report") {
    const { markdown, failed } = report(JSON.parse(process.env.NEEDS ?? "{}"));
    process.stdout.write(markdown);
    if (failed) console.error(`::warning title=Stock OpenClaw::${failed} step(s) failed on stock OpenClaw; see the run summary`);
  } else if (mode === "tail" && logDir) {
    process.stdout.write(tails(JSON.parse(process.env.STEPS ?? "{}"), logDir));
  } else {
    console.error("Usage: stock-openclaw-summary.mjs report | tail <log-dir>");
    process.exit(2);
  }
}
