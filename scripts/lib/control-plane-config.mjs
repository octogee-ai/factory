import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTROL_PLANE_VARIABLES = 'terraform/environments/control-plane/variables.tf';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {string} name
 * @param {string} [root]
 * @returns {string}
 */
export function controlPlaneDefault(name, root = REPO_ROOT) {
  const lines = readFileSync(join(root, CONTROL_PLANE_VARIABLES), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === `variable "${name}" {`);
  if (start === -1) throw new Error(`${CONTROL_PLANE_VARIABLES} declares no variable "${name}"`);
  const end = lines.indexOf('}', start + 1);
  const defaults = lines
    .slice(start + 1, end === -1 ? lines.length : end)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('default'))
    .map((line) => /^default *= *"([^"]+)"$/.exec(line));
  if (defaults.length !== 1 || !defaults[0]) {
    throw new Error(`${CONTROL_PLANE_VARIABLES} variable "${name}" has no single string default`);
  }
  return defaults[0][1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(controlPlaneDefault(process.argv[2] ?? ''));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
