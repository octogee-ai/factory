const LEGACY_IMAGE_TAG_PATTERN = /^[a-f0-9]{7,40}(?:-oc[a-z0-9][a-z0-9.-]*)?$/;
const W9_CANDIDATE_IMAGE_TAG_PATTERN = /^agent-conversation-w9a-[a-f0-9]{8}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function isGatewayImageTag(value: string): boolean {
  const digestSeparator = value.indexOf("@");
  if (digestSeparator < 0) return LEGACY_IMAGE_TAG_PATTERN.test(value);
  const imageTag = value.slice(0, digestSeparator);
  const digest = value.slice(digestSeparator + 1);
  return (
    IMAGE_DIGEST_PATTERN.test(digest) &&
    (LEGACY_IMAGE_TAG_PATTERN.test(imageTag) || W9_CANDIDATE_IMAGE_TAG_PATTERN.test(imageTag))
  );
}

export const IMAGE_TAG_PATTERN = { test: isGatewayImageTag };
