import { describe, expect, it } from "vitest";
import { SHA, describeFleet, fleet, fleetWithoutEnvironment, mutations, onlyMutation } from "./harness.js";

const MUTATING_COMMANDS: readonly (readonly string[])[] = [
  ["gateway", "deploy", "shared-a", `--sha=${SHA}`],
  ["gateway", "park", "shared-a"],
  ["user", "assign", "alan", "--to=shared-b"],
  ["user", "migrate", "ada", "--to=shared-b"],
];

describeFleet("every mutating command", () => {
  it.each(MUTATING_COMMANDS)("prints the request and sends no mutation without --apply: %s %s", async (...argv) => {
    const run = await fleet(argv);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.stdout).toMatch(/dry run/i);
  });

  it.each(MUTATING_COMMANDS)("sends exactly one mutating request with --apply: %s %s", async (...argv) => {
    const run = await fleet([...argv, "--apply"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toHaveLength(1);
  });

  it("forwards --idempotency-key as the request's idempotency key", async () => {
    const run = await fleet(["gateway", "deploy", "shared-a", `--sha=${SHA}`, "--idempotency-key=deploy-1", "--apply"]);
    expect(onlyMutation(run).idempotencyKey).toBe("deploy-1");
  });

  it("refuses an empty --idempotency-key and sends nothing", async () => {
    const run = await fleet(["gateway", "deploy", "shared-a", `--sha=${SHA}`, "--idempotency-key=", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.requests).toEqual([]);
  });

  it("refuses --apply with a value", async () => {
    const run = await fleet(["gateway", "park", "shared-a", "--apply=yes"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("refuses an unknown flag and sends nothing", async () => {
    const run = await fleet(["gateway", "park", "shared-a", "--color=blue", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.requests).toEqual([]);
  });

  it("refuses a repeated flag and sends nothing", async () => {
    const run = await fleet(["user", "assign", "alan", "--to=shared-a", "--to=shared-b", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.requests).toEqual([]);
  });

  it("refuses an unknown user before any mutation", async () => {
    const run = await fleet(["user", "assign", "nobody", "--to=shared-a", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("refuses an unknown gateway before any mutation", async () => {
    const run = await fleet(["user", "assign", "alan", "--to=nowhere", "--apply"]);
    expect(run.exitCode).not.toBe(0);
    expect(mutations(run)).toEqual([]);
  });
});

describeFleet("the environment", () => {
  it("is required, and nothing is sent without it", async () => {
    const run = await fleetWithoutEnvironment(["gateway", "ls"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.requests).toEqual([]);
  });

  it("must name an environment from the operator's configuration", async () => {
    const run = await fleetWithoutEnvironment(["--env=elsewhere", "gateway", "ls"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.requests).toEqual([]);
  });
});

describeFleet("help", () => {
  it("prints the command list and exits 0 for `fleet help`", async () => {
    const run = await fleetWithoutEnvironment(["help"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("gateway");
    expect(run.stdout).toContain("user");
  });

  it("prints the command list and exits non-zero when no command is given", async () => {
    const run = await fleetWithoutEnvironment([]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toContain("gateway");
  });

  it("exits non-zero for an unknown command without sending anything", async () => {
    const run = await fleet(["gateways", "list"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.requests).toEqual([]);
  });
});

describe("operator identity", () => {
  it.todo("authenticates every Admin API request with the operator token the selected environment names");
  it.todo("never mints identity-provider tokens and needs no database or cloud credentials");
  it.todo("refuses to send a request when the token is missing, expired or lacks the operator role");
});

describe("journal", () => {
  it.todo("prints the operation id the Admin API returns for an applied mutation, so the operator can follow it with `ops ls`");
});
