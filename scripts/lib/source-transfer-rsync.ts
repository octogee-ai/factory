import * as path from 'node:path';
import * as fs from 'node:fs';
import { isValidProjectId, isValidUsername } from '../../shared/types/identity.js';
import { deferredProjectPlaceholder } from './deferred-project-workspace.js';
import { LIVE_AGENT_STORE_EXCLUDE_ARGS } from './agent-store-snapshot.js';
import { SQLITE_CARRY_EXCLUDE_ARGS } from './agent-store-carry.js';
import type { TransferSource } from './source-transfer-plan.js';
import { CODEX_STORE_EXCLUDE_ARGS } from './codex-store-snapshot.js';

export function sourceTransferRsyncArgs(sources: TransferSource[], passwordFile: string, destination: string, mode?: string): string[] {
 return ['-a', '--relative', ...(mode === 'final' ? ['--delete-delay'] : []), '--ignore-missing-args', '--compress', '--compress-choice=zstd', '--checksum-choice=xxh128', ...LIVE_AGENT_STORE_EXCLUDE_ARGS, ...CODEX_STORE_EXCLUDE_ARGS, ...SQLITE_CARRY_EXCLUDE_ARGS, ...sources.flatMap(deferredProjectPlaceholderExcludes), '--password-file', passwordFile, ...sources.map(source => `${path.resolve(source.cwd)}/./${source.path.split(path.sep).join('/')}`), destination];
}

function deferredProjectPlaceholderExcludes(source: TransferSource): string[] {
 const parts = source.path.split(path.sep);
 const slug = parts[1];
 if (parts.length !== 2 || parts[0] !== 'customers' || !slug || !isValidUsername(slug)) return [];
 const projects = path.join(source.cwd, source.path, 'projects');
 let entries: fs.Dirent[];
 try { entries = fs.readdirSync(projects, { withFileTypes: true }); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
  throw error;
 }
 return entries.flatMap(entry => {
  if (!entry.isDirectory() || !isValidProjectId(entry.name)) return [];
  const filename = path.join(projects, entry.name, 'AGENTS.md');
  const expected = deferredProjectPlaceholder(slug, entry.name);
  try {
   const stat = fs.lstatSync(filename);
   if (!stat.isFile() || stat.size !== Buffer.byteLength(expected) || fs.readFileSync(filename, 'utf8') !== expected) return [];
  } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
  throw error;
 }
  return [`--exclude=/customers/${slug}/projects/${entry.name}/AGENTS.md`];
 });
}
