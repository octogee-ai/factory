import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_PLANE_VARIABLES, controlPlaneDefault } from "../lib/control-plane-config.mjs";

const module = resolve(import.meta.dirname, "../lib/control-plane-config.mjs");

const variables = `variable "project_id" {
  description = "Control-plane project"
  type        = string
  default     = "acme-central"
}

variable "monitoring_iap_domain" {
  type    = string
  default = "grafana.example.test"

  validation {
    condition     = length(var.monitoring_iap_domain) > 0
    error_message = "default = \\"not this\\""
  }
}

variable "members" {
  type    = list(string)
  default = ["user:a@example.test"]
}

variable "region" {
  type = string
}
`;

function repo(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "control-plane-config-"));
  mkdirSync(join(root, "terraform/environments/control-plane"), { recursive: true });
  writeFileSync(join(root, CONTROL_PLANE_VARIABLES), source);
  return root;
}

describe("control-plane config", () => {
  it("reads a declared string default from the control-plane Terraform variables", () => {
    const root = repo(variables);
    expect(controlPlaneDefault("project_id", root)).toBe("acme-central");
    expect(controlPlaneDefault("monitoring_iap_domain", root)).toBe("grafana.example.test");
  });

  it("refuses a variable that is undeclared, has no default, or has a non-string default", () => {
    const root = repo(variables);
    expect(() => controlPlaneDefault("absent", root)).toThrow(/declares no variable "absent"/);
    expect(() => controlPlaneDefault("region", root)).toThrow(/variable "region" has no single string default/);
    expect(() => controlPlaneDefault("members", root)).toThrow(/variable "members" has no single string default/);
  });

  it("prints the default for shell callers and exits non-zero when it cannot", () => {
    const root = repo(variables);
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    const copied = join(root, "scripts/lib/control-plane-config.mjs");
    copyFileSync(module, copied);
    const found = spawnSync(process.execPath, [copied, "project_id"], { encoding: "utf8" });
    expect(found.status).toBe(0);
    expect(found.stdout).toBe("acme-central");
    const missing = spawnSync(process.execPath, [copied, "absent"], { encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('declares no variable "absent"');
  });
});
