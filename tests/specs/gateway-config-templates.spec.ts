import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../../infra/gateway/verify-config-templates.mjs");
const roots: string[] = [];

function fixture(builder: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gateway-template-test-"))); roots.push(root);
  for (const name of ["templates", "extensions", "npm", "bin"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "templates/openclaw.template.json"), JSON.stringify({ kind: "shared" }));
  writeFileSync(join(root, "templates/openclaw.builder.template.json"), JSON.stringify({ kind: "builder", ...builder }));
  const cli = join(root, "bin/openclaw"), log = join(root, "calls.jsonl");
  writeFileSync(cli, `#!${process.execPath}
const fs=require('fs');const path=require('path');const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),config,configPath:process.env.OPENCLAW_CONFIG_PATH,gatewayClass:process.env.GATEWAY_CLASS,
 projected:fs.realpathSync(path.join(process.env.OPENCLAW_STATE_DIR,'extensions')),npm:fs.realpathSync(path.join(process.env.OPENCLAW_STATE_DIR,'npm'))})+'\\n');
if(config.reject){process.stderr.write('unsupported config key');process.exit(2);}
process.stdout.write(JSON.stringify({valid:config.invalidReport!==true}));
`);
  chmodSync(cli, 0o755);
  const run = () => spawnSync(process.execPath, [helper, join(root, "templates"), join(root, "extensions"), join(root, "npm"), cli], {
    encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, run, calls };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Native config template image gate", () => {
  it("validates both raw templates with projected image plugins and isolated runtime state", () => {
    const f = fixture(), result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls();
    expect(calls.map(call => ({ args: call.args, config: call.config, gatewayClass: call.gatewayClass }))).toEqual([
      { args: ["config", "validate", "--json"], config: { kind: "shared" }, gatewayClass: "shared" },
      { args: ["config", "validate", "--json"], config: { kind: "builder" }, gatewayClass: "builder" },
    ]);
    for (const call of calls) {
      expect(call.projected).toBe(join(f.root, "extensions")); expect(call.npm).toBe(join(f.root, "npm"));
      expect(existsSync(call.configPath)).toBe(false);
    }
  });
  it.each([{ reject: true }, { invalidReport: true }])("fails the image when the Builder template is rejected: %o", rejection => {
    const f = fixture(rejection), result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("openclaw.builder.template.json");
    expect(f.calls()).toHaveLength(2);
    for (const call of f.calls()) expect(existsSync(call.configPath)).toBe(false);
  });
});
