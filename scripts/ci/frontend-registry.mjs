export function siteSsrRepository(environment) {
  if (!['test', 'prod'].includes(environment)) throw new Error('SSR release environment must be test or prod');
  return `us-central1-docker.pkg.dev/octogee/octogee-ssr-${environment}`;
}
