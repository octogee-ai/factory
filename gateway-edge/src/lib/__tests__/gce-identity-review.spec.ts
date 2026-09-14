import { describe, expect, it, vi } from "vitest";
import {
  computeInstanceFromPayload,
  createGceIdentityReviewer,
  createIssuerDispatchingReviewer,
  isGoogleIssuedJwt,
  parseGatewayComputerIdentity,
} from "../gce-identity-review.js";
import type { Reviewer } from "../kubernetes-token-review.js";

const EXPECTED = {
  projectId: "octogee",
  serviceAccountEmail: "octogee-computer-test@octogee.iam.gserviceaccount.com",
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

  it("reviews a verified computer identity token as the computer service account in the gateway's namespace", async () => {
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

  it("fails closed when verification throws, returns nothing, the issuer is not Google, or the instance claims do not match", async () => {
    expect(await createGceIdentityReviewer({ ...options, verify: async () => { throw new Error("bad sig"); } })("x.y.z")).toEqual({ authenticated: false });
    expect(await createGceIdentityReviewer({ ...options, verify: async () => null })("x.y.z")).toEqual({ authenticated: false });
    expect(await createGceIdentityReviewer({ ...options, verify: async () => payload({ iss: "https://evil.example" }) })("x.y.z")).toEqual({ authenticated: false });
    expect(await createGceIdentityReviewer({ ...options, verify: async () => payload({ email: "other@octogee.iam.gserviceaccount.com" }) })("x.y.z")).toEqual({ authenticated: false });
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

describe("parseGatewayComputerIdentity", () => {
  it("is off when neither variable is set, on when both are, and loud when only one is", () => {
    expect(parseGatewayComputerIdentity({})).toBeNull();
    expect(parseGatewayComputerIdentity({
      GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL: " sa@p.iam.gserviceaccount.com ",
      GATEWAY_COMPUTER_PROJECT_ID: "p",
    })).toEqual({ serviceAccountEmail: "sa@p.iam.gserviceaccount.com", projectId: "p" });
    expect(() => parseGatewayComputerIdentity({ GATEWAY_COMPUTER_PROJECT_ID: "p" })).toThrow(/set together/);
  });
});
