export const BUILDER_ACTIVATION_STATUSES = [
    "requested",
    "provisioning",
    "activating",
    "active",
    "returning",
];
export function isBuilderActivationStatus(value) {
    return BUILDER_ACTIVATION_STATUSES.includes(value);
}
export const WORKSPACE_GATEWAY_STATUS_MAX_SLUGS = 50;
