import { createHash } from "node:crypto";
import {
  GATEWAY_DESKTOP_NODE_CONTAINER,
  GATEWAY_DESKTOP_RUNTIME_DIR,
  gatewayVmPodName,
  type GatewayVmRuntimeBundle,
  type GatewayVmRuntimeContainer,
  type GatewayVmRuntimeVolume,
} from "@octogee/shared/types/glm";
import { GATEWAY_HOST_DESKTOP_AUTH_DIR } from "../openclaw-computer-browser.js";

export const BUNDLE_VERSION_LABEL = "ai.octogee.bundle-version";
export const CONTAINER_SPEC_LABEL = "ai.octogee.container-spec";
export const INIT_SPEC_LABEL = "ai.octogee.init-spec";
export const NO_INIT_SPEC = "none";
export const GATEWAY_ID_LABEL = "ai.octogee.gateway-id";
export const NAMESPACE_LABEL = "ai.octogee.namespace";
export const CONTAINER_NAME_LABEL = "ai.octogee.container";
export const CONTAINER_ROLE_LABEL = "ai.octogee.role";
export const LOGGED_LABELS = [GATEWAY_ID_LABEL, NAMESPACE_LABEL, CONTAINER_NAME_LABEL, CONTAINER_ROLE_LABEL] as const;

export function loggedLabelsFor(bundle: Pick<GatewayVmRuntimeBundle, "namespace">): string[] {
  return LOGGED_LABELS.filter((label) => label !== NAMESPACE_LABEL || Boolean(bundle.namespace));
}
export const RUNTIME_UID = "1000:1000";
export const TOKEN_FILE = "token";
export const CA_FILE = "ca.crt";

export interface PlanContext {
  stateRoot: string;
  instanceId: string;
  desktopAuth: boolean;
}

export interface DockerContainerSpec {
  name: string;
  config: Record<string, unknown>;
}

export interface BundlePlan {
  init: DockerContainerSpec | null;
  services: DockerContainerSpec[];
}

export function containerName(container: Pick<GatewayVmRuntimeContainer, "name">): string {
  return `octogee-${container.name}`;
}

export function volumeHostPath(stateRoot: string, volume: GatewayVmRuntimeVolume): string {
  return volume.kind === "emptyDir" ? `${stateRoot}/volumes/${volume.name}` : `${stateRoot}/tokens/${volume.name}`;
}

export function volumeByName(bundle: GatewayVmRuntimeBundle, name: string): GatewayVmRuntimeVolume {
  const volume = bundle.volumes.find((candidate) => candidate.name === name);
  if (!volume) throw new Error(`bundle ${bundle.version}: mount references unknown volume ${name}`);
  return volume;
}

function bindsFor(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer, ctx: PlanContext): string[] {
  return container.mounts.map((mount) => {
    const volume = volumeByName(bundle, mount.volume);
    const host = mount.subPath ? `${volumeHostPath(ctx.stateRoot, volume)}/${mount.subPath}` : volumeHostPath(ctx.stateRoot, volume);
    return `${host}:${mount.mountPath}${mount.readOnly ? ":ro" : ""}`;
  });
}

function mountsKubernetesApi(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer): boolean {
  return container.mounts.some((mount) => volumeByName(bundle, mount.volume).kind === "kubernetesApi");
}

export function envFor(bundle: GatewayVmRuntimeBundle, container: GatewayVmRuntimeContainer, ctx: PlanContext): string[] {
  const env: Record<string, string> = { ...container.env };
  if ("POD_UID" in env) env.POD_UID = gatewayVmPodName(bundle.gatewayId, ctx.instanceId);
  if ("GATEWAY_COMPUTER_INSTANCE_ID" in env) env.GATEWAY_COMPUTER_INSTANCE_ID = ctx.instanceId;
  if (mountsKubernetesApi(bundle, container)) {
    env.KUBERNETES_SERVICE_HOST = bundle.kubernetes.apiHost;
    env.KUBERNETES_SERVICE_PORT = bundle.kubernetes.apiPort;
    env.KUBERNETES_SERVICE_PORT_HTTPS = bundle.kubernetes.apiPort;
  }
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

export function containerSpecVersion(config: Record<string, unknown>): string {
  const { Labels: _labels, ...spec } = config;
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
}

export function planContainer(
  bundle: GatewayVmRuntimeBundle,
  container: GatewayVmRuntimeContainer,
  ctx: PlanContext,
  role: "init" | "service",
): DockerContainerSpec {
  const config: Record<string, unknown> = {
    Image: container.image,
    User: RUNTIME_UID,
    Env: envFor(bundle, container, ctx),
    ...(container.command ? { Entrypoint: container.command } : {}),
    ...(container.args ? { Cmd: container.args } : {}),
    HostConfig: {
      NetworkMode: "host",
      Binds: [
        ...bindsFor(bundle, container, ctx),
        ...(role === "service" && container.name === "gateway" ? ["/home/octo/Documents:/home/octo/Documents"] : []),
        ...(role === "service" && container.name === GATEWAY_DESKTOP_NODE_CONTAINER
          // eslint-disable-next-line sonarjs/publicly-writable-directories -- XWayland requires its standard socket directory; the mount is read-only.
          ? [`${GATEWAY_DESKTOP_RUNTIME_DIR}:${GATEWAY_DESKTOP_RUNTIME_DIR}`, "/tmp/.X11-unix:/tmp/.X11-unix:ro"]
          : []),
      ],
      ...(role === "service" && container.name === "gateway" && ctx.desktopAuth ? {
        Mounts: [{
          Type: "bind",
          Source: `${GATEWAY_DESKTOP_RUNTIME_DIR}/octogee-openclaw-vnc`,
          Target: GATEWAY_HOST_DESKTOP_AUTH_DIR,
          ReadOnly: true,
        }],
      } : {}),
      ExtraHosts: Object.entries(bundle.hostAliases).map(([host, ip]) => `${host}:${ip}`),
      RestartPolicy: { Name: role === "service" ? "unless-stopped" : "no" },
      LogConfig: { Type: "gcplogs", Config: { labels: loggedLabelsFor(bundle).join(",") } },
    },
  };
  config.Labels = {
    [BUNDLE_VERSION_LABEL]: bundle.version,
    [CONTAINER_SPEC_LABEL]: containerSpecVersion(config),
    [GATEWAY_ID_LABEL]: bundle.gatewayId,
    ...(bundle.namespace ? { [NAMESPACE_LABEL]: bundle.namespace } : {}),
    [CONTAINER_NAME_LABEL]: container.name,
    [CONTAINER_ROLE_LABEL]: role,
  };
  return { name: containerName(container), config };
}

export function specVersion(spec: DockerContainerSpec): string {
  return (spec.config.Labels as Record<string, string>)[CONTAINER_SPEC_LABEL];
}

export function planBundle(bundle: GatewayVmRuntimeBundle, ctx: PlanContext): BundlePlan {
  const init = bundle.init ? planContainer(bundle, bundle.init, ctx, "init") : null;
  const initSpec = init ? specVersion(init) : NO_INIT_SPEC;
  const services = bundle.containers.map((container) => {
    const service = planContainer(bundle, container, ctx, "service");
    (service.config.Labels as Record<string, string>)[INIT_SPEC_LABEL] = initSpec;
    return service;
  });
  return { init, services };
}

export function planInitSpec(plan: BundlePlan): string {
  return plan.init ? specVersion(plan.init) : NO_INIT_SPEC;
}

export function imagesToPull(bundle: GatewayVmRuntimeBundle): string[] {
  const refs = new Set<string>();
  if (bundle.init) refs.add(bundle.init.image);
  for (const container of bundle.containers) refs.add(container.image);
  return [...refs];
}

type Inspection = { Config?: { Labels?: Record<string, string> } } | null;

export function runningVersion(inspection: Inspection): string | null {
  return inspection?.Config?.Labels?.[BUNDLE_VERSION_LABEL] ?? null;
}

export function runningSpec(inspection: Inspection): string | null {
  return inspection?.Config?.Labels?.[CONTAINER_SPEC_LABEL] ?? null;
}

export function runningInitSpec(inspection: Inspection): string | null {
  return inspection?.Config?.Labels?.[INIT_SPEC_LABEL] ?? null;
}
