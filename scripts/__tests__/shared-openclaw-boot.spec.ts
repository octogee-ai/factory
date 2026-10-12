import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runOpenClawBootPhase } from "../entrypoints/openclaw-boot-sentinel.js";

const repo = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it("repairs a retained configured default database after its failed Shared boot and before readiness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-openclaw-boot-")); roots.push(root);
  const database = path.join(root, "agents/octogee-unmatched-route/agent/openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(database), { recursive: true });
  await fs.writeFile(path.join(root, "openclaw.json"), JSON.stringify({ agents: { entries: {
    "octogee-unmatched-route": { default: true },
  } } }));
  const db = new DatabaseSync(database);
  db.exec("PRAGMA user_version=24; CREATE TABLE history(body TEXT); INSERT INTO history VALUES ('retained default state')"); db.close();
  const fakeCli = path.join(root, "native-contract.mjs");
  await fs.writeFile(fakeCli, `
import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
const root=process.env.QUAL_BOOT_ROOT, database=root+'/agents/octogee-unmatched-route/agent/openclaw-agent.sqlite';
const append=value=>fs.appendFileSync(root+'/order.log',value+'\\n');
if(process.argv[2]==='doctor'){
 if(fs.existsSync(root+'/writer-active')) throw Error('Doctor must not run while the prior gateway writer is active');
 const db=new DatabaseSync(database);db.exec('PRAGMA user_version=25');db.close();append('doctor');process.exit(0);
}
const db=new DatabaseSync(database),version=db.prepare('PRAGMA user_version').get().user_version;db.close();
append('gateway-'+version);
if(version!==25){console.error('configured default schema24 requires canonical Doctor');process.exit(1);}
fs.writeFileSync(root+'/writer-active','true');fs.writeFileSync(root+'/healthy','true');
process.on('SIGTERM',()=>{fs.rmSync(root+'/writer-active',{force:true});process.exit(0)});
setInterval(()=>{},1000);
`);
  const hook = path.join(root, "boot-hook.mts");
  await fs.writeFile(hook, `
import fs from 'node:fs';import {execFileSync} from 'node:child_process';
import {runOpenClawBootPhase} from ${JSON.stringify(path.join(repo, "scripts/entrypoints/openclaw-boot-sentinel.ts"))};
const root=process.env.QUAL_BOOT_ROOT,file=root+'/sentinel';
await runOpenClawBootPhase(process.argv[2],{log:()=>{},
client:{claimOpenClawBoot:async()=>{const prior=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
 const action=prior==='starting'?'doctor':'start';
 if(!prior)fs.writeFileSync(file,'starting');else if(action==='doctor')fs.writeFileSync(file,'doctor-attempted');return{action};},
completeOpenClawBoot:async()=>{fs.rmSync(file,{force:true});fs.appendFileSync(root+'/order.log','healthy\\n');}},
run:async(command,args)=>{execFileSync(command,args,{stdio:'inherit'});}});
`);
  const tsx = path.join(root, "tsx");
  await fs.writeFile(tsx, `#!/bin/sh\ncase "$1" in\n*prepare-openclaw-sqlite-journals.ts) exit 0;;\n*openclaw-boot-sentinel.ts) shift; exec ${quote(process.execPath)} --import ${quote(path.join(repo, "scripts/node_modules/tsx/dist/loader.mjs"))} ${quote(hook)} "$@";;\n*) exit 2;;\nesac\n`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "openclaw"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeCli)} "$@"\n`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "curl"), '#!/bin/sh\ntest -f "$QUAL_BOOT_ROOT/healthy"\n', { mode: 0o700 });
  const entrypoint = await fs.readFile(path.join(repo, "infra/gateway/entrypoint.sh"), "utf8");
  const start = entrypoint.indexOf('  "$TSX" /octogee/scripts/entrypoints/prepare-openclaw-sqlite-journals.ts');
  const end = entrypoint.indexOf('\nfi', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const shell = `set -e\nTSX=${quote(tsx)}\nlog(){ :; }\nOPENCLAW_PID=''\ntrap 'test -z "$OPENCLAW_PID" || kill "$OPENCLAW_PID" 2>/dev/null || true' EXIT\n${entrypoint.slice(start, end)}\n`;
  const boot = () => spawnSync("sh", ["-s"], { input: shell, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: root+path.delimiter+process.env.PATH, QUAL_BOOT_ROOT: root, OPENCLAW_DIR: root,
      OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"), GATEWAY_ID: "shared-fixture", BUILD_SHA: "qualified-new-image" } });
  const first = boot(); expect(first.status).toBe(1);
  const second = boot(); expect(second.status, second.stderr).toBe(0);
  const verified = new DatabaseSync(database, { readOnly: true });
  try { expect(verified.prepare("PRAGMA user_version").get()?.user_version).toBe(25);
    expect(verified.prepare("SELECT body FROM history").get()?.body).toBe("retained default state"); }
  finally { verified.close(); }
  expect((await fs.readFile(path.join(root, "order.log"), "utf8")).trim().split("\n"))
    .toEqual(["gateway-24", "doctor", "gateway-25", "healthy"]);
});


it("uses the installed build identity when in-place recovery retains the old pod image tag", async () => {
  const client = { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "start" }), completeOpenClawBoot: vi.fn().mockResolvedValue(undefined) };
  const input = { client, env: { GATEWAY_ID: "shared-fixture", BUILD_SHA: "new-build-sha", GATEWAY_IMAGE_TAG: "old-pod-tag" } };
  await runOpenClawBootPhase("before-start", input);
  await runOpenClawBootPhase("healthy", input);
  expect(client.claimOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "new-build-sha" });
  expect(client.completeOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "new-build-sha" });
});

it("fails the pre-start phase when the claimed canonical repair fails", async () => {
  const client = { claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "doctor" }), completeOpenClawBoot: vi.fn() };
  const run = vi.fn().mockRejectedValue(new Error("canonical repair failed"));
  await expect(runOpenClawBootPhase("before-start", { client, run, log: () => {}, env: { GATEWAY_ID: "shared-fixture", BUILD_SHA: "build-sha" } })).rejects.toThrow("canonical repair failed");
  expect(run).toHaveBeenCalledWith("openclaw", ["doctor", "--fix", "--non-interactive"]);
  expect(client.completeOpenClawBoot).not.toHaveBeenCalled();
});
