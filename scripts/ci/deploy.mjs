import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseOptions } from './release-plan.mjs';
import { resolveRelease, downloadReleaseSource } from './release-source.mjs';
import { dispatchWorkflow } from './actions-dispatch.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const options = releaseOptions(args.filter(arg => arg !== '--local'));
if (!local) {
  if (options.shipTest) throw new Error('Use ci:ship-test for the hosted fleet workflow');
  await dispatchWorkflow('deploy.yml', {
    source_sha: options.sha, environment: options.environment, actor: options.actor,
    log_level: options.logLevel, post_deploy_checks: String(Boolean(options.checks)),
  });
} else {
  const directory = mkdtempSync(join(tmpdir(), 'octogee-deploy-'));
  const run = (file, values, extra = {}) => execFileSync(file, values, { stdio: 'inherit', ...extra });
  try {
    const { manifest, digest } = await resolveRelease(options.sha);
    const archive = await downloadReleaseSource(manifest);
    const source = join(directory, 'source');
    mkdirSync(source);
    writeFileSync(join(directory, 'source.tgz'), archive);
    run('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1]) as t: t.extractall(sys.argv[2],filter="data")', join(directory, 'source.tgz'), source]);
    writeFileSync(join(source, 'ci-release-manifest.json'), JSON.stringify(manifest));
    console.log(`Deploy ${options.environment}: ${manifest.sourceSha} (${digest})`);
    const releaseArgs = args.filter(arg => arg !== '--local');
    run(process.execPath, ['scripts/ci/release.mjs', ...releaseArgs], { cwd: source, env: { ...process.env, CI_RELEASE_MANIFEST: join(source, 'ci-release-manifest.json') } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
