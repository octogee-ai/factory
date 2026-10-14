import { desktopRunId } from './main-build.mjs';
import { validateDesktopRelease } from '../lib/desktop-image-release.mjs';
export { validateDesktopRelease } from '../lib/desktop-image-release.mjs';

export async function desktopBuild(options, deps) {
  if (!options.actions || options.branch !== 'main' || !options.clean || !/^[a-f0-9]{40}$/.test(options.sourceSha)
      || options.checkoutSha !== options.sourceSha) throw new Error('Desktop construction requires the explicit main GitHub Actions job');
  desktopRunId(options.runId);
  const build = await deps.main();
  if (build.manifest.sourceSha !== options.sourceSha) throw new Error('Desktop source differs from the selected main build');
  return deps.lock(async () => {
    const existing = await deps.lookup(build);
    if (existing) return existing;
    const desktopImage = await deps.desktop(build);
    return deps.publish(validateDesktopRelease({ schemaVersion: 1, sourceSha: options.sourceSha,
      manifestDigest: build.digest, gatewayDigest: build.manifest.surfaces.gateway['octogee-gateway-builder'], desktopImage }, build));
  });
}

export async function waitForMainBuild(sha, { read, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 90 * 60_000 }) {
  const deadline = now() + timeout;
  for (;;) {
    try { return await read(sha); }
    catch (error) { if (error.status !== 404) throw error; }
    if (now() >= deadline) throw new Error(`Main build ${sha} is not published; submit it with ci:submit main before requesting the desktop image`);
    console.log(`Waiting for immutable main build ${sha}`);
    await sleep(30_000);
  }
}
