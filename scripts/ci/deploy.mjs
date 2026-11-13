import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseOptions } from './release-plan.mjs';
import { resolveRelease } from './release-source.mjs';
import { deploymentSource, sourceCiScript, sourceEnvironment } from './snapshot.mjs';
import { dispatchWorkflow } from './actions-dispatch.mjs';

const args = process.argv.slice(2);
const local = args.includes('--local');
const options = releaseOptions(args.filter(arg => arg !== '--local'));
if (!local) {
  if (options.shipTest || options.shipProd) throw new Error('Use ci:ship-test or ci:ship-prod for hosted fleet shipments');
  await dispatchWorkflow('deploy.yml', {
    source_sha: options.sha, environment: options.environment, actor: options.actor,
    log_level: options.logLevel, post_deploy_checks: String(Boolean(options.checks)),
  });
} else {
  const { manifest, digest } = await resolveRelease(options.sha);
  const directory = mkdtempSync(join(tmpdir(), 'octogee-deploy-'));
  const root = execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const copy = deploymentSource(root, manifest.sourceSha);
  try {
    const manifestPath = join(directory, 'ci-release-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    console.log(`Deploy ${options.environment}: ${manifest.sourceSha} (${digest})`);
    execFileSync(process.execPath, [sourceCiScript(copy.source, 'release.mjs'), ...args.filter(arg => arg !== '--local')], {
      cwd: copy.source, stdio: 'inherit', env: { ...sourceEnvironment(root, copy.source, process.env), CI_RELEASE_MANIFEST: manifestPath },
    });
  } finally {
    copy.remove();
    rmSync(directory, { recursive: true, force: true });
  }
}
