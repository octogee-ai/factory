export function releaseOptions(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--(environment|sha|actor|log-level)=(.+)$/.exec(arg);
    if (match) {
      if (options[match[1]]) throw new Error(`Duplicate ${match[1]}`);
      options[match[1]] = match[2];
    } else if (arg === '--ship-test') options.shipTest = true;
    else if (arg === '--post-deploy-checks') options.checks = true;
    else throw new Error(`Unknown release argument ${arg}`);
  }
  if (!['test', 'prod'].includes(options.environment) || !/^[a-f0-9]{40}$/.test(options.sha ?? '') || !options.actor || !['chart-default', 'info', 'debug'].includes(options['log-level'] ?? 'chart-default')) throw new Error('Release requires environment, full SHA, actor, and a valid log level');
  if (options.shipTest && options.environment !== 'test') throw new Error('Complete fleet deployment is only supported by Ship TEST');
  return { ...options, logLevel: options['log-level'] ?? 'chart-default' };
}

export async function deployRelease(options, deps) {
  const manifest = await deps.manifest(options.sha);
  if (manifest.sourceSha !== options.sha) throw new Error('Selected immutable manifest differs from requested SHA');
  return deps.lock(async () => {
    await deps.platform(manifest);
    await deps.site(manifest);
    await deps.desktop(manifest);
    if (options.shipTest) await deps.fleet(manifest);
  });
}
