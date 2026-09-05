import {
  createGceIdentityReviewer,
  createIssuerDispatchingReviewer,
  parseGatewayComputerIdentity,
} from "./gce-identity-review.js";
import {
  createKubernetesTokenReviewer,
  TENANT_BINDING_AUDIENCE,
  type KubernetesTokenReviewerOptions,
  type Reviewer,
} from "./token-review.js";

export function createGatewayIdentityReviewer(
  kubernetes: KubernetesTokenReviewerOptions,
  input: { namespace: string; env?: Record<string, string | undefined> },
): Reviewer {
  const k8s = createKubernetesTokenReviewer(kubernetes);
  const computer = parseGatewayComputerIdentity(input.env ?? process.env);
  if (!computer) return k8s;
  return createIssuerDispatchingReviewer({
    kubernetes: k8s,
    gce: createGceIdentityReviewer({
      ...computer,
      audience: kubernetes.audience ?? TENANT_BINDING_AUDIENCE,
      namespace: input.namespace,
    }),
  });
}
