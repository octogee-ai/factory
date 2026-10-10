import * as path from 'node:path';
import { LIVE_AGENT_STORE_EXCLUDE_ARGS } from './agent-store-snapshot.js';
import { SQLITE_CARRY_EXCLUDE_ARGS } from './agent-store-carry.js';
import type { TransferSource } from './source-transfer-plan.js';
import { CODEX_STORE_EXCLUDE_ARGS } from './codex-store-snapshot.js';

export function sourceTransferRsyncArgs(sources: TransferSource[], passwordFile: string, destination: string, mode?: string): string[] {
 return ['-a', '--relative', ...(mode === 'final' ? ['--delete-delay'] : []), '--ignore-missing-args', '--compress', '--compress-choice=zstd', '--checksum-choice=xxh128', ...LIVE_AGENT_STORE_EXCLUDE_ARGS, ...CODEX_STORE_EXCLUDE_ARGS, ...SQLITE_CARRY_EXCLUDE_ARGS, '--password-file', passwordFile, ...sources.map(source => `${path.resolve(source.cwd)}/./${source.path.split(path.sep).join('/')}`), destination];
}
