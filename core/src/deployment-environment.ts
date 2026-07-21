export type DeploymentEnvironment = "prod" | "test" | "build-week";
export type ResolvedDeploymentEnvironment = DeploymentEnvironment | "unknown";

export interface DeploymentEnvironmentSettings {
  name: DeploymentEnvironment;
  namespace: string;
  firebaseProjectId: string;
  siteOrigin: string;
  appOrigin: string;
  apiOrigin: string;
  gitOrigin: string;
  mattermostOrigin: string;
  previewOrigin: string;
  gatewayValuesFile: string;
  computeClass: string;
  pinEnvironment: string;
}

const ENVIRONMENTS: Record<DeploymentEnvironment, DeploymentEnvironmentSettings> = {
  prod: {
    name: "prod",
    namespace: "octogee",
    firebaseProjectId: "octogee",
    siteOrigin: "https://octogee.com",
    appOrigin: "https://app.octogee.com",
    apiOrigin: "https://api.octogee.com",
    gitOrigin: "https://git.octogee.com",
    mattermostOrigin: "https://mattermost.octogee.com",
    previewOrigin: "https://preview.octogee.com",
    gatewayValuesFile: "values.prod.yaml",
    computeClass: "octogee-gateway",
    pinEnvironment: "prod",
  },
  test: {
    name: "test",
    namespace: "octogee-test",
    firebaseProjectId: "octogee-test",
    siteOrigin: "https://octogee-test.web.app",
    appOrigin: "https://app-octogee-test.web.app",
    apiOrigin: "https://api-test.octogee.com",
    gitOrigin: "https://git-test.octogee.com",
    mattermostOrigin: "https://mattermost-test.octogee.com",
    previewOrigin: "https://preview-test.octogee.com",
    gatewayValuesFile: "values.test.yaml",
    computeClass: "octogee-gateway-test",
    pinEnvironment: "test",
  },
  "build-week": {
    name: "build-week",
    namespace: "octogee-build-week",
    firebaseProjectId: "octogee-build-week",
    siteOrigin: "https://octogee-build-week.web.app",
    appOrigin: "https://app-octogee-build-week.web.app",
    apiOrigin: "https://api-build-week.octogee.com",
    gitOrigin: "https://git-build-week.octogee.com",
    mattermostOrigin: "https://mattermost-build-week.octogee.com",
    previewOrigin: "https://preview-build-week.octogee.com",
    gatewayValuesFile: "values.build-week.yaml",
    computeClass: "octogee-gateway-build-week",
    pinEnvironment: "build-week",
  },
};

export const BUILD_WEEK_ENVIRONMENT = ENVIRONMENTS["build-week"];

export function deploymentEnvironmentSettings(
  environment: DeploymentEnvironment,
): DeploymentEnvironmentSettings {
  return ENVIRONMENTS[environment];
}

export function deploymentEnvironmentForNamespace(
  namespace: string,
): ResolvedDeploymentEnvironment {
  const entry = Object.values(ENVIRONMENTS).find((value) => value.namespace === namespace);
  return entry?.name ?? "unknown";
}

export function deploymentEnvironmentForProject(
  projectId: string,
): ResolvedDeploymentEnvironment {
  const entry = Object.values(ENVIRONMENTS).find(
    (value) => value.firebaseProjectId === projectId,
  );
  return entry?.name ?? "unknown";
}

function hostingOrigins(settings: DeploymentEnvironmentSettings): string[] {
  const project = settings.firebaseProjectId;
  if (settings.name === "prod") {
    return [
      settings.siteOrigin,
      settings.appOrigin,
      "https://www.octogee.com",
      "https://octogee.web.app",
      "https://app-octogee.web.app",
      "https://octogee.firebaseapp.com",
      "https://app-octogee.firebaseapp.com",
    ];
  }
  return [
    settings.siteOrigin,
    settings.appOrigin,
    `https://${project}.firebaseapp.com`,
    `https://app-${project}.firebaseapp.com`,
  ];
}

export function publicAppOrigins(): string[] {
  return [...new Set(
    (Object.keys(ENVIRONMENTS) as DeploymentEnvironment[])
      .flatMap((environment) => hostingOrigins(ENVIRONMENTS[environment])),
  )];
}

export function publicAppHosts(): string[] {
  return publicAppOrigins().map((origin) => new URL(origin).hostname);
}
