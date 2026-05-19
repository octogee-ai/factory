import type { GatewayDesiredState, GatewayProfile } from "../../shared/types/glm.js";

/**
 * Profile → image name. Cowboy-side canonical mirror of
 * `infra/gateway/profiles.yaml` (keep the names identical — a mismatch
 * points a live gateway at a non-existent image). `standard` is
 * intentionally absent: it uses the desired state's literal
 * `imageRepository`, so the entire existing cattle fleet is
 * byte-unaffected. A new profile is one row here + one in profiles.yaml.
 */
export const PROFILE_IMAGE_NAME: Record<Exclude<GatewayProfile, "standard">, string> = {
  operator: "octogee-gateway-operator",
};

/**
 * The image repository Cowboy deploys for an instance. Profile
 * unset/`standard` ⇒ the literal `imageRepository` (zero regression).
 * A non-standard profile ⇒ the profile image at the SAME registry/
 * project as the instance's own `imageRepository` (always the standard
 * `<registry>/<project>/octogee-gateway`), with the final image-name
 * segment swapped. No hardcoded AR host/project: profile resolution
 * follows any future Artifact Registry relocation automatically.
 * Deployed at the instance's unchanged `imageTag` (the profile image is
 * built FROM the standard image at the same fleet SHA, so the SHA axis
 * and the profile axis stay orthogonal).
 */
export function resolveGatewayImageRepository(
  d: Pick<GatewayDesiredState, "profile" | "imageRepository">,
): string {
  if (!d.profile || d.profile === "standard") return d.imageRepository;
  const base = d.imageRepository.replace(/\/[^/]+$/, "");
  return `${base}/${PROFILE_IMAGE_NAME[d.profile]}`;
}
