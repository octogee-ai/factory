import { describe, it, expect } from "vitest";
import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-mm-deletion-chart-");

function envValue(deployment: string, name: string): string | null {
  const re = new RegExp(`-\\s+name:\\s+${name}\\s*\\n\\s+value:\\s+"?([^"\\n]+)"?`, "m");
  const m = deployment.match(re);
  return m ? m[1] : null;
}

// The fleet controller's deprovision-customer permanently deletes the user's MM team and
// users; both APIs are hard-gated by these ServiceSettings flags (401
// api.user.delete_team.not_enabled.for_admin.app_error otherwise).
describe("umbrella — mattermost permanent-deletion settings", () => {
  it("enables API team deletion", () => {
    const dep = findDoc(chart.helmTemplate(), "Deployment", "mattermost");
    expect(dep).toBeTruthy();
    expect(envValue(dep!, "MM_SERVICESETTINGS_ENABLEAPITEAMDELETION")).toBe("true");
  });

  it("enables API user deletion so deprovision frees the username", () => {
    const dep = findDoc(chart.helmTemplate(), "Deployment", "mattermost");
    expect(dep).toBeTruthy();
    expect(envValue(dep!, "MM_SERVICESETTINGS_ENABLEAPIUSERDELETION")).toBe("true");
  });
});
