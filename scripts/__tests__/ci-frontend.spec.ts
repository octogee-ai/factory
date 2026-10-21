import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: command }));

beforeEach(() => {
  vi.resetModules();
  command.mockReset();
  vi.stubEnv('SOURCE_SHA', 'a'.repeat(40));
  vi.stubEnv('RELEASE_ENVIRONMENT', 'test');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ apiKey: 'public-key', appId: 'app', messagingSenderId: 'sender', projectId: 'octogee-test' }),
  })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('rejects an unknown SSR release environment before building packages', async () => {
  vi.stubEnv('RELEASE_ENVIRONMENT', 'candidate');
  await expect(import('../ci/frontend.mjs')).rejects.toThrow('SSR release environment must be test or prod');
  expect(command).not.toHaveBeenCalled();
});

function tools(lookup: () => string) {
  command.mockImplementation((file: string, _args: string[]) => {
    if (file === 'node' && _args[0] === '-p') return process.env.FAKE_NODE_24_VERSION ?? '24.12.0';
    if (file === 'node') return 'hosting_project_id=octogee-test\nfirebase_project_id=octogee-test\nartifact_registry_repository=us-central1-docker.pkg.dev/octogee/octogee\napi_origin=https://api-test.octogee.com\napp_origin=https://app-test.octogee.com\nsite_origin=https://octogee-test.web.app\ngit_origin=https://git-test.octogee.com';
    if (file === 'gcloud') return 'public-posthog-token';
    if (file === 'bash') return lookup();
    return '';
  });
}

it('builds site and app with the Node 24 toolchain while Cloud Functions keeps the Node 22 default', async () => {
  vi.stubEnv('CI_NODE_24_BIN', '/opt/node24/bin');
  tools(() => 'sha256:existing');
  await import('../ci/frontend.mjs');
  const npmCalls = command.mock.calls.filter(([file]) => file === 'npm');
  expect(npmCalls).toHaveLength(6);
  for (const [, , options] of npmCalls) {
    const onNode24 = options.env.PATH.startsWith(`/opt/node24/bin:`);
    expect(onNode24).toBe(options.cwd !== 'functions');
  }
});

it.each(['22.20.0', '24.11.9'])('stops before installing any frontend package when the Node 24 toolchain resolves to %s', async version => {
  vi.stubEnv('FAKE_NODE_24_VERSION', version);
  tools(() => 'sha256:existing');
  await expect(import('../ci/frontend.mjs')).rejects.toThrow('require Node >=24.12');
  expect(command.mock.calls.filter(([file]) => file === 'npm')).toEqual([]);
});

it('verifies frontend packages while reusing an existing SHA-addressed SSR image', async () => {
  tools(() => 'sha256:existing');
  await import('../ci/frontend.mjs');
  expect(command.mock.calls.filter(([file, args]) => file === 'npm' && args[0] === 'run')).toHaveLength(3);
  expect(command.mock.calls.filter(([file]) => file === 'docker')).toEqual([]);
});

it('publishes an SSR image only after its SHA tag is confirmed absent', async () => {
  tools(() => { throw Object.assign(new Error('absent'), { status: 3 }); });
  await import('../ci/frontend.mjs');
  expect(command.mock.calls.some(([file, args]) => file === 'docker' && args.includes('--push'))).toBe(true);
  const authentication = command.mock.calls.findIndex(([file, args]) => file === 'gcloud' && args.join(' ') === 'auth configure-docker us-central1-docker.pkg.dev --quiet');
  const builder = command.mock.calls.findIndex(([file, args]) => file === 'docker' && args[1] === 'create');
  expect(authentication).toBeGreaterThanOrEqual(0);
  expect(authentication).toBeLessThan(builder);
  expect(command.mock.calls.some(([file, args]) => file === 'docker' && args.some(value => value.startsWith('--cache-from=')))).toBe(false);
});

it('does not create a builder or publish when registry credential setup fails', async () => {
  tools(() => { throw Object.assign(new Error('absent'), { status: 3 }); });
  const backend = command.getMockImplementation()!;
  command.mockImplementation((file, args) => {
    if (file === 'gcloud' && args[1] === 'configure-docker') throw new Error('credential setup denied');
    return backend(file, args);
  });
  await expect(import('../ci/frontend.mjs')).rejects.toThrow('credential setup denied');
  expect(command.mock.calls.filter(([file]) => file === 'docker')).toEqual([]);
});

it('imports an existing registry cache into each fresh SSR builder', async () => {
  let lookups = 0;
  tools(() => {
    if (++lookups === 1) throw Object.assign(new Error('image absent'), { status: 3 });
    return 'sha256:cached';
  });
  await import('../ci/frontend.mjs');
  expect(command.mock.calls.some(([file, args]) => file === 'docker' && args.includes('--cache-from=type=registry,ref=us-central1-docker.pkg.dev/octogee/octogee-ssr-test/cache/site-ssr:buildcache'))).toBe(true);
});

it.each(['test', 'prod'])('writes SSR images and cache only to the %s release repository', async environment => {
  vi.stubEnv('RELEASE_ENVIRONMENT', environment);
  tools(() => { throw Object.assign(new Error('absent'), { status: 3 }); });
  await import('../ci/frontend.mjs');
  const build = command.mock.calls.find(([file, args]) => file === 'docker' && args.includes('--push'))![1];
  expect(build).toContain(`--tag=us-central1-docker.pkg.dev/octogee/octogee-ssr-${environment}/site-ssr:${environment}-${'a'.repeat(8)}`);
  expect(build).toContain(`--cache-to=type=registry,ref=us-central1-docker.pkg.dev/octogee/octogee-ssr-${environment}/cache/site-ssr:buildcache,mode=max`);
  expect(build.join(' ')).not.toContain('us-central1-docker.pkg.dev/octogee/octogee/');
});

it('stops publication when the registry cache lookup fails and cleans up its builder', async () => {
  let lookups = 0;
  tools(() => { throw Object.assign(new Error(++lookups === 1 ? 'image absent' : 'cache denied'), { status: lookups === 1 ? 3 : 1 }); });
  await expect(import('../ci/frontend.mjs')).rejects.toThrow('cache denied');
  expect(command.mock.calls.some(([file, args]) => file === 'docker' && args.includes('--push'))).toBe(false);
  expect(command.mock.calls.some(([file, args]) => file === 'docker' && args[0] === 'buildx' && args[1] === 'rm')).toBe(true);
});

it('fails closed when SSR image lookup fails', async () => {
  tools(() => { throw Object.assign(new Error('permission denied'), { status: 1 }); });
  await expect(import('../ci/frontend.mjs')).rejects.toThrow('permission denied');
  expect(command.mock.calls.filter(([file]) => file === 'docker')).toEqual([]);
});
