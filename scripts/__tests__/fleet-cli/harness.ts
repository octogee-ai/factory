import { describe } from "vitest";

export type AdminMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface AdminRequest {
  readonly method: AdminMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

export interface FixtureUser {
  readonly id: string;
  readonly name: string;
  readonly gatewayId?: string;
}

export interface FixtureGateway {
  readonly id: string;
  readonly kind: "shared" | "isolated";
  readonly desiredStatus: "running" | "paused";
  readonly ownerId?: string;
  readonly mountedUserIds: readonly string[];
}

export interface FleetFixture {
  readonly environment: string;
  readonly users: readonly FixtureUser[];
  readonly gateways: readonly FixtureGateway[];
}

export interface FleetRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: readonly AdminRequest[];
}

export interface FleetHarness {
  run(argv: readonly string[], fixture: FleetFixture): Promise<FleetRun>;
}

export const FIXTURE: FleetFixture = {
  environment: "local",
  users: [
    { id: "u-ada", name: "ada", gatewayId: "shared-a" },
    { id: "u-grace", name: "grace", gatewayId: "iso-grace" },
    { id: "u-alan", name: "alan" },
  ],
  gateways: [
    { id: "shared-a", kind: "shared", desiredStatus: "running", mountedUserIds: ["u-ada"] },
    { id: "shared-b", kind: "shared", desiredStatus: "running", mountedUserIds: [] },
    { id: "iso-grace", kind: "isolated", desiredStatus: "running", ownerId: "u-grace", mountedUserIds: ["u-grace"] },
    { id: "shared-parked", kind: "shared", desiredStatus: "paused", mountedUserIds: [] },
  ],
};

export const SHA = "0123456789abcdef0123456789abcdef01234567";

export function fleetHarness(): FleetHarness | null {
  return null;
}

export const describeFleet = describe.skipIf(fleetHarness() === null);

export async function fleet(argv: readonly string[], fixture: FleetFixture = FIXTURE): Promise<FleetRun> {
  const harness = fleetHarness();
  if (harness === null) throw new Error("the fleet command line is not in this repository yet");
  return harness.run(["--env=" + fixture.environment, ...argv], fixture);
}

export async function fleetWithoutEnvironment(argv: readonly string[], fixture: FleetFixture = FIXTURE): Promise<FleetRun> {
  const harness = fleetHarness();
  if (harness === null) throw new Error("the fleet command line is not in this repository yet");
  return harness.run(argv, fixture);
}

export function mutations(run: FleetRun): AdminRequest[] {
  return run.requests.filter(request => request.method !== "GET");
}

export function onlyMutation(run: FleetRun): AdminRequest {
  const sent = mutations(run);
  if (sent.length !== 1) throw new Error(`expected exactly one mutating request, saw ${sent.length}`);
  return sent[0];
}
