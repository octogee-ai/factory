import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StubHost, createStubHost, stubClusterTools } from "./stub-host";

const SETTINGS = {
  DOMAIN: "platform.your-company.com",
  ACME_EMAIL: "ops@octogee.com",
  GCP_PROJECT: "stub-project",
  AWS_REGION: "eu-west-1",
};

const GCLOUD_STUB = `case " $* " in
  *" vpc-peerings list "*) ;;
  *" iam service-accounts list "*) echo stub-files-account ;;
  *" storage hmac create "*) printf 'STUBACCESS\\tSTUBSECRET\\n' ;;
  *" sql instances describe "*--format*) echo 10.20.0.3 ;;
  *" describe "*) exit 1 ;;
esac`;

const AWS_STUB = `case " $* " in
  *" eks describe-cluster "*"--query"*) echo stub-value ;;
  *" eks describe-cluster "*) exit 1 ;;
  *" ec2 describe-security-groups "*) echo None ;;
  *" ec2 create-security-group "*) echo sg-stub ;;
  *" ec2 describe-subnets "*) printf 'subnet-a\\tsubnet-b\\n' ;;
  *" rds describe-db-subnet-groups "*) exit 1 ;;
  *" rds describe-db-instances "*"--query"*) echo stub.database.host ;;
  *" rds describe-db-instances "*) exit 1 ;;
  *" sts get-caller-identity "*) echo 111122223333 ;;
  *" s3api head-bucket "*) exit 1 ;;
  *" iam get-user "*) exit 1 ;;
  *" iam create-access-key "*) printf 'STUBACCESS\\tSTUBSECRET\\n' ;;
esac`;

let host: StubHost;

function lines(tool: string): string[] {
  return host.calls().filter((line) => line.startsWith(`${tool} `));
}

beforeEach(() => {
  host = createStubHost();
  stubClusterTools(host);
});

afterEach(() => host.remove());

describe.each([
  { provider: "gcp", cli: "gcloud", stub: GCLOUD_STUB, extra: ["gke-gcloud-auth-plugin"] },
  { provider: "aws", cli: "aws", stub: AWS_STUB, extra: ["eksctl"] },
])("deploy/cloud/$provider.sh", ({ provider, cli, stub, extra }) => {
  beforeEach(() => {
    host.stub(cli, stub);
    for (const tool of extra) host.stub(tool, 'cat >/dev/null');
  });

  it("stops before touching the provider when a setting is missing", () => {
    const run = host.run(`deploy/cloud/${provider}.sh`, []);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("missing settings");
    expect(lines(cli)).toEqual([]);
  });

  it("completes against the provider and installs no self-hosted database or object store", () => {
    const run = host.run(`deploy/cloud/${provider}.sh`, [], { env: SETTINGS });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const all = host.calls().join("\n");
    expect(all).not.toContain("manifests/postgres.yaml");
    expect(all).not.toContain("manifests/seaweedfs.yaml");
    expect(run.stdout).toContain("203.0.113.10");
    expect(run.stdout).toContain("chat.platform.your-company.com");
  });

  it("keeps every cluster call off the operator's default kubeconfig", () => {
    host.run(`deploy/cloud/${provider}.sh`, [], { env: SETTINGS });
    const expected = `KUBECONFIG=${join(host.home, ".kube", `octogee-cloud-${provider}`)}`;
    const clusterCalls = [...lines("kubectl"), ...lines("helm")];
    expect(clusterCalls.length).toBeGreaterThan(0);
    for (const call of clusterCalls) expect(call).toContain(expected);
    for (const call of lines("helm")) expect(call).toContain("--kube-context stub-context");
    for (const call of lines("kubectl").filter((line) => !line.includes("config current-context"))) {
      expect(call).toContain("--context stub-context");
    }
  });

  it("stores both halves of the storage key", () => {
    host.run(`deploy/cloud/${provider}.sh`, [], { env: SETTINGS });
    const secret = lines("kubectl").find((line) => line.includes("create secret generic object-store"));
    expect(secret).toContain("--from-literal=access-key=STUBACCESS");
    expect(secret).toContain("--from-literal=secret-key=STUBSECRET");
  });
});

describe("deploy/cloud/check.sh", () => {
  it("requires a provider name", () => {
    const run = host.run("deploy/cloud/check.sh", [], { env: SETTINGS });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("gcp or aws");
  });
});

describe("the local recipes", () => {
  beforeEach(() => {
    host.stub("docker", "exit 0");
    host.stub("kind", 'case "$*" in create*) cat > "${HOME}/kind-config" ;; esac');
  });

  it("creates its own cluster, bound to loopback, without touching the default kubeconfig", () => {
    mkdirSync(join(host.home, ".kube"));
    const run = host.run("deploy/local/up.sh", []);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const config = readFileSync(join(host.home, "kind-config"), "utf8");
    expect(config).toContain("hostPort: 8088");
    expect(config).toContain("listenAddress: 127.0.0.1");
    const expected = `KUBECONFIG=${join(host.home, ".kube", "octogee-cloud-local")}`;
    for (const call of [...lines("kind"), ...lines("kubectl"), ...lines("helm")]) expect(call).toContain(expected);
  });

  it("fails the check run when a check fails", () => {
    host.stub("kind", 'echo octogee-cloud');
    host.stub("kubectl", 'case "$*" in *logs*) exit 1 ;; *search*) echo agent ;; esac');
    const run = host.run("deploy/local/check.sh", []);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL  Gateway connected to chat");
    expect(run.stderr).toContain("1 of the checks failed");
  });

});
