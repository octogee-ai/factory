import type { GatewayDesiredState, GatewayProfile } from "../../shared/types/glm.js";

export const PROFILE_IMAGE_NAME: Record<Exclude<GatewayProfile, "standard">, string> = {
  operator: "octogee-gateway-operator",
};

export function resolveGatewayImageRepository(
  d: Pick<GatewayDesiredState, "profile" | "imageRepository">,
): string {
  if (!d.profile || d.profile === "standard") return d.imageRepository;
  const base = d.imageRepository.replace(/\/[^/]+$/, "");
  return `${base}/${PROFILE_IMAGE_NAME[d.profile]}`;
}
