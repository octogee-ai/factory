import { octogeeUserEntitlements } from "@octogee/shared/types/octogee-entitlements";
import { installUserEntitlements } from "@octogee/shared/types/user-entitlements";

installUserEntitlements(octogeeUserEntitlements);

for (const name of ["ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "PLATFORM_OPENAI_BASE_URL", "PLATFORM_VERTEX_BASE_URL"]) {
  delete process.env[name];
}
