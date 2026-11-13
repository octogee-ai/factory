import { execFileSync } from 'node:child_process';
import { dispatchWorkflow } from './actions-dispatch.mjs';

const [kind, ...args] = process.argv.slice(2);
if (kind !== 'main' || args.some(arg => arg !== '--force' && !/^--sha=[a-f0-9]{40}$/.test(arg))) throw new Error('usage: npm run ci:submit -- main [--sha=<main SHA>] [--force]');
const git = values => execFileSync('/usr/bin/git', values, { encoding: 'utf8' }).trim();
const sha = args.find(value => value.startsWith('--sha='))?.slice(6) ?? git(['rev-parse', 'HEAD']);
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full source SHA is required');
git(['merge-base', '--is-ancestor', sha, 'origin/main']);
await dispatchWorkflow('build-main.yml', { source_sha: sha, force: String(args.includes('--force')) });
