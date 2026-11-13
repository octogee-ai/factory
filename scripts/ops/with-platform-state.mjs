import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fleetStoreDependencies, withFleetStore } from '../ci/fleet-store.mjs';

export const WITH_PLATFORM_STATE_USAGE =
  'Usage: npm run --prefix scripts with-platform-state -- --env=test|prod -- <command> [args...]';

export function parseWithPlatformStateArgs(argv) {
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const unknown = options.find((arg) => !arg.startsWith('--env='));
  if (unknown !== undefined) return { kind: 'error', message: `Unknown arg: ${unknown}\n${WITH_PLATFORM_STATE_USAGE}` };
  const environment = options.find((arg) => arg.startsWith('--env='))?.slice('--env='.length);
  if (environment !== 'test' && environment !== 'prod') {
    return { kind: 'error', message: `--env must be test or prod\n${WITH_PLATFORM_STATE_USAGE}` };
  }
  if (command.length === 0) {
    return { kind: 'error', message: `a command to run is required after --\n${WITH_PLATFORM_STATE_USAGE}` };
  }
  return { kind: 'ok', environment, command };
}

export function runCommand(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal === null ? (code ?? 1) : 1));
  });
}

export function withPlatformState({
  environment,
  command,
  deps = fleetStoreDependencies(environment),
  run = runCommand,
  baseEnv = process.env,
}) {
  return withFleetStore(deps, (storeEnv) => run(command, { ...baseEnv, ...storeEnv }));
}

async function main(argv) {
  const parsed = parseWithPlatformStateArgs(argv);
  if (parsed.kind === 'error') {
    console.error(parsed.message);
    return 2;
  }
  return withPlatformState(parsed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
