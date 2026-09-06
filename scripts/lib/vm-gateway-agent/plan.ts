import {
  GATEWAY_DESKTOP_NODE_CONTAINER,
  GATEWAY_DESKTOP_RUNTIME_DIR,
  gatewayVmPodName,
  type GatewayVmRuntimeBundle,
  type GatewayVmRuntimeContainer,
  type GatewayVmRuntimeVolume,
} from "@octogee/shared/types/glm";

export const BUNDLE_VERSION_LABEL = "ai.octogee.bundle-version";
export const GATEWAY_ID_LABEL = "ai.octogee.gateway-id";
export const CONTAINER_ROLE_LABEL = "ai.octogee.role";
export const RUNTIME_UID = "1000:1000";
export const TOKEN_FILE = "token";
export const CA_FILE = "ca.crt";

export interface PlanContext {
  stateRoot: string;
  instanceId: string;
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
  if (mountsKubernetesApi(bundle, container)) {
    env.KUBERNETES_SERVICE_HOST = bundle.kubernetes.apiHost;
    env.KUBERNETES_SERVICE_PORT = bundle.kubernetes.apiPort;
    env.KUBERNETES_SERVICE_PORT_HTTPS = bundle.kubernetes.apiPort;
  }
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

export function planContainer(
  bundle: GatewayVmRuntimeBundle,
  container: GatewayVmRuntimeContainer,
  ctx: PlanContext,
  role: "init" | "service",
): DockerContainerSpec {
  return {
    name: containerName(container),
    config: {
      Image: container.image,
      User: RUNTIME_UID,
      Env: envFor(bundle, container, ctx),
      ...(container.command ? { Entrypoint: container.command } : {}),
      ...(container.args ? { Cmd: container.args } : {}),
      Labels: {
        [BUNDLE_VERSION_LABEL]: bundle.version,
        [GATEWAY_ID_LABEL]: bundle.gatewayId,
        [CONTAINER_ROLE_LABEL]: role,
      },
      HostConfig: {
        NetworkMode: "host",
        Binds: [
          ...bindsFor(bundle, container, ctx),
          ...(role === "service" && container.name === "gateway" ? ["/home/octo/Documents:/home/octo/Documents"] : []),
          ...(role === "service" && container.name === GATEWAY_DESKTOP_NODE_CONTAINER
            ? [`${GATEWAY_DESKTOP_RUNTIME_DIR}:${GATEWAY_DESKTOP_RUNTIME_DIR}`]
            : []),
        ],
        ExtraHosts: Object.entries(bundle.hostAliases).map(([host, ip]) => `${host}:${ip}`),
        RestartPolicy: { Name: role === "service" ? "unless-stopped" : "no" },
        LogConfig: { Type: "json-file", Config: { "max-size": "50m", "max-file": "3" } },
      },
    },
  };
}

export function planBundle(bundle: GatewayVmRuntimeBundle, ctx: PlanContext): BundlePlan {
  return {
    init: bundle.init ? planContainer(bundle, bundle.init, ctx, "init") : null,
    services: bundle.containers.map((container) => planContainer(bundle, container, ctx, "service")),
  };
}

export function imagesToPull(bundle: GatewayVmRuntimeBundle): string[] {
  const refs = new Set<string>();
  if (bundle.init) refs.add(bundle.init.image);
  for (const container of bundle.containers) refs.add(container.image);
  return [...refs];
}

export function runningVersion(inspection: { Config?: { Labels?: Record<string, string> } } | null): string | null {
  return inspection?.Config?.Labels?.[BUNDLE_VERSION_LABEL] ?? null;
}
