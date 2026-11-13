import { createHash } from 'node:crypto';

export function imageTag(dockerfile, installer, architecture) {
  const digest = createHash('sha256').update(dockerfile).update('\0').update(installer).digest('hex').slice(0, 16);
  return `octogee-ci-local:${architecture}-${digest}`;
}
