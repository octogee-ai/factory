import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStubHost, REPO_ROOT, type StubHost } from "./deploy/stub-host";

const SCRIPT = join(REPO_ROOT, "scripts/ops/kind-install.sh");
const REGISTRY = "ghcr.io/octogee-ai/octogee-cloud";
const IMAGES = ["glm-controller", "octogee-api", "gateway-edge", "octogee-gateway", "mattermost"];
const PUBLISHED = "b".repeat(40);
const CHECKOUT = "c".repeat(40);
const AMD64 = `sha256:${"1".repeat(64)}`;
const ARM64 = `sha256:${"2".repeat(64)}`;
const INDEX = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: AMD64, size: 1, platform: { os: "linux", architecture: "amd64" } },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: ARM64, size: 1, platform: { os: "linux", architecture: "arm64" } },
  ],
});

const DOCKER = `case " $* " in
  *" imagetools inspect "*) printf '%s' "$INDEX" ;;
  *" imagetools create "*) exit 0 ;;
  *" bake "*) exit 1 ;;
  *"{{.State.Running}}"*) echo true ;;
  *"Networks.kind"*) echo '{}' ;;
  *" exec -i "*) cat >/dev/null ;;
esac`;

const KUBECTL = `case " $* " in
  *"%{http_code}"*) echo 200 ;;
  *"jsonpath={.data."*) printf 'c3R1Yg==' ;;
  *" team search "*) echo '"name": "octogee"' ;;
  *" -f - "* | *" exec -i "*) cat >/dev/null ;;
  *"-o yaml"*) echo "kind: stub" ;;
esac`;

const KIND = `case "$1 $2" in
  "get nodes") echo octogee-control-plane ;;
  "create cluster") cat >/dev/null ;;
esac`;

const SSH_KEYGEN = `while [ $# -gt 0 ]; do [ "$1" = -f ] && file="$2"; shift; done
echo key > "$file"; echo key > "$file.pub"`;

describe("kind-install.sh", () => {
  let host: StubHost;
  let state: string;

  beforeEach(() => {
    host = createStubHost();
    state = mkdtempSync(join(tmpdir(), "kind-install-state-"));
    symlinkSync(process.execPath, join(host.bin, "node"));
    symlinkSync(["/bin/chmod", "/usr/bin/chmod"].find(path => existsSync(path))!, join(host.bin, "chmod"));
    host.stub("docker", DOCKER);
    host.stub("kubectl", KUBECTL);
    host.stub("kind", KIND);
    host.stub("helm", "");
    host.stub("git", `echo ${CHECKOUT}`);
    host.stub("openssl", "echo 0123456789abcdef");
    host.stub("ssh-keygen", SSH_KEYGEN);
  });

  afterEach(() => {
    host.remove();
    rmSync(state, { recursive: true, force: true });
  });

  const run = (args: string[], machine = "arm64") => {
    host.stub("uname", `echo ${machine}`);
    return host.run(SCRIPT, args, { env: { OCTOGEE_KIND_STATE: state, INDEX } });
  };
  const copies = () => host.calls().filter(call => call.includes(" imagetools create "));
  const inspected = () => host.calls().filter(call => call.includes(" imagetools inspect "));
  const json = (file: string) => JSON.parse(readFileSync(join(state, "octogee", file), "utf8"));

  it("runs as an executable", () => {
    const result = spawnSync(SCRIPT, ["help"], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--pull");
  });

  it("installs the images published for a commit, copying the host platform's manifests instead of building", () => {
    const result = run(["up", "--pull", `--sha=${PUBLISHED}`]);
    expect(result.stderr).not.toContain("kind-install:");
    expect(result.status).toBe(0);
    expect(inspected()).toEqual(IMAGES.map(name => `docker KUBECONFIG=unset buildx imagetools inspect ${REGISTRY}/${name}:${PUBLISHED} --raw`));
    expect(copies()).toEqual(IMAGES.map(name =>
      `docker KUBECONFIG=unset buildx imagetools create --prefer-index=false --tag=localhost:5001/octogee/${name}:bbbbbbb ${REGISTRY}/${name}@${ARM64}`));
    expect(host.calls().filter(call => call.includes(" bake "))).toEqual([]);
    expect(json("digests.json")).toEqual({ platform: "linux/arm64", sha: PUBLISHED, images: Object.fromEntries(IMAGES.map(name => [name, ARM64])) });
    const values = json("images.yaml");
    expect(values["glm-controller"].image).toEqual({ repository: "localhost:5001/octogee/glm-controller", tag: "bbbbbbb", digest: ARM64 });
    expect(values["glm-controller"].platformRelease).toMatchObject({ sourceSha: PUBLISHED, gatewayImageTag: `bbbbbbb@${ARM64}` });
    expect(values["octogee-api"].replicas).toBeUndefined();
  });

  it("reinstalls the copied images under their own commit when rerun with --skip-build", () => {
    expect(run(["up", "--pull", `--sha=${PUBLISHED}`]).status).toBe(0);
    const copied = copies().length;
    const result = run(["up", "--skip-build"]);
    expect(result.status).toBe(0);
    expect(copies()).toHaveLength(copied);
    expect(json("images.yaml")["glm-controller"].platformRelease.sourceSha).toBe(PUBLISHED);
  });

  it("copies the amd64 images of the checkout's commit on an x86_64 host", () => {
    const result = run(["up", "--pull"], "x86_64");
    expect(result.status).toBe(0);
    expect(inspected()[0]).toBe(`docker KUBECONFIG=unset buildx imagetools inspect ${REGISTRY}/glm-controller:${CHECKOUT} --raw`);
    expect(copies()[0]).toBe(
      `docker KUBECONFIG=unset buildx imagetools create --prefer-index=false --tag=localhost:5001/octogee/glm-controller:ccccccc ${REGISTRY}/glm-controller@${AMD64}`);
    expect(json("digests.json").platform).toBe("linux/amd64");
  });

  it.each([
    [["--pull", "--skip-build"], "Choose either --pull or --skip-build"],
    [[`--sha=${PUBLISHED}`], "--sha needs --pull"],
    [["--pull", "--sha=bbbbbbb"], "--sha needs a full commit SHA"],
  ])("refuses up %j before touching anything", (args, message) => {
    const result = run(["up", ...args]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(host.calls()).toEqual([]);
  });
});
