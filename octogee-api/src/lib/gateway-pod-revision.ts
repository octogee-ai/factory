const RELEASE_NUMBER = /^[1-9]\d{0,8}$/u;
const GENERATED_POD_SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/u;

export function revisionIdFromGatewayPodName(
  gatewayId: string,
  podName: string | undefined,
): string | null {
  if (!podName) return null;
  const prefix = `octogee-gateway-${gatewayId}-r`;
  if (!podName.startsWith(prefix)) return null;
  const suffix = podName.slice(prefix.length);
  const separator = suffix.indexOf("-");
  if (separator <= 0) return null;
  const release = suffix.slice(0, separator);
  const generatedSuffix = suffix.slice(separator + 1);
  if (!RELEASE_NUMBER.test(release) || !GENERATED_POD_SUFFIX.test(generatedSuffix)) return null;
  return `${gatewayId}-r${release}`;
}
