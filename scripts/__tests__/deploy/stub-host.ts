import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const BASE_UTILITIES = ["base64", "cat", "cut", "dirname", "grep", "mkdir", "printenv", "rm", "sed", "tr"];

export interface StubHost {
  home: string;
  bin: string;
  stub(name: string, body: string): void;
  calls(): string[];
  run(script: string, args: readonly string[], options?: RunOptions): SpawnSyncReturns<string>;
  remove(): void;
}

export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
}

function utilityPath(name: string): string {
  const found = [`/usr/bin/${name}`, `/bin/${name}`].find((path) => existsSync(path));
  if (!found) throw new Error(`base utility ${name} is not on this system`);
  return found;
}

export function createStubHost(): StubHost {
  const root = mkdtempSync(join(tmpdir(), "deploy-stub-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(log, "");
  for (const name of BASE_UTILITIES) symlinkSync(utilityPath(name), join(bin, name));

  const stub = (name: string, body: string) => {
    const logged = `echo "${name} KUBECONFIG=\${KUBECONFIG:-unset} $*" >> "\${CALLS}"`;
    writeFileSync(join(bin, name), `#!/bin/bash\n${logged}\n${body}\n`, { mode: 0o755 });
  };

  return {
    home,
    bin,
    stub,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    run: (script, args, options = {}) =>
      spawnSync("/bin/bash", script === "-" ? ["-s", "--", ...args] : [script, ...args], {
        encoding: "utf8",
        cwd: options.cwd ?? REPO_ROOT,
        input: options.input ?? "",
        env: { HOME: home, PATH: bin, CALLS: log, ...options.env },
      }),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function stubUname(host: StubHost, kernel: string, release: string): void {
  host.stub("uname", `case "\${1}" in -r) echo "${release}" ;; *) echo "${kernel}" ;; esac`);
}

export const KUBECTL_STUB = `case " $* " in
  *" config current-context "*) echo stub-context ;;
  *"jsonpath={.data."*) printf 'c3R1Yg==' ;;
  *"loadBalancer"*) echo 203.0.113.10 ;;
  *" get secret "* | *" get namespace "*) exit 1 ;;
  *" -f - "*) cat >/dev/null ;;
  *"-o yaml"*) echo "kind: stub" ;;
esac`;

export const CURL_STUB = `case " $* " in
  *" -i "*) printf 'HTTP/1.1 200 OK\\r\\nToken: stub-session\\r\\n\\r\\n{}' ;;
  */users/username/*) exit 22 ;;
  */bots*) echo '{"user_id":"stub-bot"}' ;;
  */tokens*) echo '{"token":"stub-token"}' ;;
  *) echo '{"status":"OK"}' ;;
esac`;

export function stubClusterTools(host: StubHost): void {
  host.stub("kubectl", KUBECTL_STUB);
  host.stub("helm", "exit 0");
  host.stub("curl", CURL_STUB);
  host.stub("openssl", "echo deadbeef");
}
