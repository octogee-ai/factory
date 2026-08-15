import { describe, expect, it } from "vitest";

import {
  cloneGithubProjectCheckout,
  githubCloneCredentialEnv,
} from "./github-project-clone.js";

describe("GitHub project clone broker", () => {
  it("keeps the clone credential in an environment variable for a scoped Git helper", () => {
    expect(githubCloneCredentialEnv("gho_secret")).toEqual({
      OCTOGEE_GITHUB_TOKEN: "gho_secret",
    });
  });

  it("rejects an unsafe destination before attempting a clone", async () => {
    await expect(cloneGithubProjectCheckout({
      customersRoot: "/tmp/customers",
      builderSlug: "../alice",
      projectSlug: "octo",
      repository: { owner: "octogee-ai", repo: "octogee" },
      accessToken: "gho_secret",
    })).rejects.toThrow("invalid GitHub project clone request");
  });
});
