import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDesktopRelease } from './desktop-build.mjs';
import { resolveDesktopRelease } from './release-source.mjs';

export async function publishDesktopRelease(value, build, temporary, deps = {
  read: resolveDesktopRelease,
  run: (file, args) => execFileSync(file, args, { stdio: 'inherit' }),
}) {
  const record = validateDesktopRelease(value, build);
  const identical = artifact => {
    if (!artifact || JSON.stringify(validateDesktopRelease(artifact, build)) !== JSON.stringify(record)) throw new Error('Desktop companion differs from the accepted immutable artifact');
    return artifact;
  };
  const existing = await deps.read(build);
  if (existing) return identical(existing);
  const directory = join(temporary, 'desktop-image-manifest');
  mkdirSync(directory);
  writeFileSync(join(directory, 'desktop-image-manifest.json'), JSON.stringify(record));
  writeFileSync(join(directory, 'Dockerfile'), 'FROM scratch\nCOPY desktop-image-manifest.json /desktop-image-manifest.json\n');
  const image = `us-central1-docker.pkg.dev/octogee/octogee/desktop-image-manifest:${record.sourceSha}`;
  deps.run('docker', ['build', '--tag', image, directory]);
  deps.run('docker', ['push', image]);
  return identical(await deps.read(build));
}
