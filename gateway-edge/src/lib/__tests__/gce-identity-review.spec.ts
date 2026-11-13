import { describe, expect, it, vi } from "vitest";
import {
  VmIdentityVerifierUnavailableError,
  computeInstanceFromPayload,
  createGceIdentityReviewer,
  createIssuerDispatchingReviewer,
  isGoogleIssuedJwt,
  parseGatewayVmIdentity,
} from "../gce-identity-review.js";
import type { Reviewer } from "../kubernetes-token-review.js";

const EXPECTED = {
  projectId: "octogee",
  serviceAccountEmail: "octogee-computer-test@octogee.iam.gserviceaccount.com",
  instanceId: "5114356976453632468",
};

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: "octogee-api",
    email: EXPECTED.serviceAccountEmail,
    email_verified: true,
    google: {
      compute_engine: {
        project_id: "octogee",
        zone: "us-central1-a",
        instance_id: "5114356976453632468",
        instance_name: "octogee-pool-9a6a3a45",
      },
    },
    ...overrides,
  };
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

describe("isGoogleIssuedJwt", () => {
  it("recognises Google's issuer and nothing else", () => {
    expect(isGoogleIssuedJwt(jwt({ iss: "https://accounts.google.com" }))).toBe(true);
    expect(isGoogleIssuedJwt(jwt({ iss: "accounts.google.com" }))).toBe(true);
    expect(isGoogleIssuedJwt(jwt({ iss: "https://kubernetes.default.svc" }))).toBe(false);
    expect(isGoogleIssuedJwt("not.a.jwt.at.all")).toBe(false);
    expect(isGoogleIssuedJwt("a.b")).toBe(false);
  });
});

describe("computeInstanceFromPayload", () => {
  it("extracts the instance identity when the SA, project, and verified email match", () => {
    expect(computeInstanceFromPayload(payload(), EXPECTED)).toEqual({
      projectId: "octogee",
      zone: "us-central1-a",
      instanceId: "5114356976453632468",
      instanceName: "octogee-pool-9a6a3a45",
    });
  });

  it("rejects another service account, an unverified email, another project, or a token without instance claims", () => {
    expect(computeInstanceFromPayload(payload({ email: "someone-else@octogee.iam.gserviceaccount.com" }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ email_verified: false }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ google: { compute_engine: { project_id: "evil", zone: "z", instance_id: "1", instance_name: "n" } } }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ google: undefined }), EXPECTED)).toBeNull();
    expect(computeInstanceFromPayload(payload({ google: { compute_engine: { project_id: "octogee", zone: "z", instance_name: "n" } } }), EXPECTED)).toBeNull();
  });
});

describe("createGceIdentityReviewer", () => {
  const options = { ...EXPECTED, audience: "octogee-api", namespace: "octogee-test" };

  it("reviews a verified VM identity token as the VM service account in the gateway's namespace", async () => {
    const verify = vi.fn(async () => payload());
    const review = await createGceIdentityReviewer({ ...options, verify })(jwt(payload()));
    expect(verify).toHaveBeenCalledWith(jwt(payload()), "octogee-api");
    expect(review).toEqual({
      authenticated: true,
      saName: "octogee-computer-test",
      namespace: "octogee-test",
      audiences: ["octogee-api"],
    });
  });

  it("rejects a bad token, an empty payload, a non-Google issuer, another service account, and says why", async () => {
    const reasons: string[] = [];
    const reviewer = (verify: () => Promise<Record<string, unknown> | null>) =>
      createGceIdentityReviewer({ ...options, verify, onRejected: (reason) => reasons.push(reason) });
    expect(await reviewer(async () => { throw new Error("Invalid token signature"); })("x.y.z")).toEqual({ authenticated: false });
    expect(await reviewer(async () => null)("x.y.z")).toEqual({ authenticated: false });
    expect(await reviewer(async () => payload({ iss: "https://evil.example" }))("x.y.z")).toEqual({ authenticated: false });
    expect(await reviewer(async () => payload({ email: "other@octogee.iam.gserviceaccount.com" }))("x.y.z")).toEqual({ authenticated: false });
    expect(reasons).toEqual([
      "token verification failed: Invalid token signature",
      "token verification returned no payload",
      "issuer https://evil.example is not Google",
      "token is not the VM service account on a Compute Engine instance in this project",
    ]);
  });

  it("rejects a token minted on another VM that shares the service account", async () => {
    const reasons: string[] = [];
    const other = payload({
      google: { compute_engine: { project_id: "octogee", zone: "us-central1-a", instance_id: "999", instance_name: "octogee-pool-other" } },
    });
    expect(await createGceIdentityReviewer({ ...options, verify: async () => other, onRejected: (r) => reasons.push(r) })("x.y.z"))
      .toEqual({ authenticated: false });
    expect(reasons).toEqual(["token was minted on instance octogee-pool-other (999), not this computer (5114356976453632468)"]);
  });

  it("surfaces a verifier outage instead of reporting a bad token", async () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND www.googleapis.com"), { code: "ENOTFOUND" });
    await expect(createGceIdentityReviewer({ ...options, verify: async () => { throw dns; } })("x.y.z"))
      .rejects.toBeInstanceOf(VmIdentityVerifierUnavailableError);
    const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    await expect(createGceIdentityReviewer({ ...options, verify: async () => { throw fetchFailed; } })("x.y.z"))
      .rejects.toThrow(/verifier unavailable/);
  });
});

describe("createIssuerDispatchingReviewer", () => {
  it("sends Google-issued tokens to the GCE reviewer and everything else to Kubernetes", async () => {
    const kubernetes = vi.fn<Reviewer>(async () => ({ authenticated: false }));
    const gce = vi.fn<Reviewer>(async () => ({ authenticated: false }));
    const reviewer = createIssuerDispatchingReviewer({ kubernetes, gce });
    await reviewer(jwt({ iss: "https://accounts.google.com" }));
    await reviewer(jwt({ iss: "https://container.googleapis.com/v1/projects/x/locations/y/clusters/z" }));
    await reviewer("malformed");
    expect(gce).toHaveBeenCalledTimes(1);
    expect(kubernetes).toHaveBeenCalledTimes(2);
  });
});

describe("parseGatewayVmIdentity", () => {
  it("is off when nothing is set, on when all three are, and loud when the set is partial or the instance id is not numeric", () => {
    expect(parseGatewayVmIdentity({})).toBeNull();
    expect(parseGatewayVmIdentity({
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: " sa@p.iam.gserviceaccount.com ",
      GATEWAY_COMPUTER_PROJECT_ID: "p",
      GATEWAY_COMPUTER_INSTANCE_ID: "4242",
    })).toEqual({ serviceAccountEmail: "sa@p.iam.gserviceaccount.com", projectId: "p", instanceId: "4242" });
    expect(() => parseGatewayVmIdentity({ GATEWAY_COMPUTER_PROJECT_ID: "p" })).toThrow(/set together/);
    expect(() => parseGatewayVmIdentity({
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: "sa@p.iam.gserviceaccount.com",
      GATEWAY_COMPUTER_PROJECT_ID: "p",
      GATEWAY_COMPUTER_INSTANCE_ID: "",
    })).toThrow(/set together/);
    expect(() => parseGatewayVmIdentity({
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: "sa@p.iam.gserviceaccount.com",
      GATEWAY_COMPUTER_PROJECT_ID: "p",
      GATEWAY_COMPUTER_INSTANCE_ID: "octogee-pool-x",
    })).toThrow(/numeric/);
  });
});
