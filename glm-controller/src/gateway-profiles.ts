import {
  resolveGatewayImageProfile,
  type GatewayDesiredState,
  type GatewayProfile,
} from "../../shared/types/glm.js";

export const PROFILE_IMAGE_NAME: Record<Exclude<GatewayProfile, "standard">, string> = {
  operator: "octogee-gateway-operator",
};

export function resolveGatewayImageRepository(
  d: Pick<GatewayDesiredState, "gatewayClass" | "imageProfile" | "profile" | "imageRepository">,
): string {
  const imageProfile = resolveGatewayImageProfile(d);
  if (imageProfile === "standard") return d.imageRepository;
  const base = d.imageRepository.replace(/\/[^/]+$/, "");
  return `${base}/${PROFILE_IMAGE_NAME[imageProfile]}`;
}
