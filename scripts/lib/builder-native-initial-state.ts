import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const INITIAL_STATE = '.builder-native-initial-state.json';
const DATABASE_FILES = new Set(['openclaw.sqlite', 'openclaw.sqlite.seal', 'openclaw.sqlite-wal', 'openclaw.sqlite-shm', 'openclaw.sqlite-journal']);

function fingerprintClient(stateDir: string): string | null {
  const hash = createHash('sha256');
  const clientDir = path.join(stateDir, 'client');
  try {
    const client = fs.lstatSync(clientDir);
    if (!client.isDirectory()) return null;
    hash.update(JSON.stringify(['client', client.dev, client.ino]));
    for (const entry of fs.readdirSync(clientDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) return null;
      const bytes = fs.readFileSync(path.join(clientDir, entry.name));
      if ((entry.name.endsWith('-wal') || entry.name.endsWith('-journal')) && bytes.length !== 0) return null;
      hash.update(JSON.stringify([entry.name, bytes.length])).update(bytes);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'client-absent';
  }
  return hash.digest('hex');
}

function fingerprint(stateDir: string): string | null {
  if (!fs.lstatSync(stateDir).isDirectory()) return null;
  const directory = path.join(stateDir, 'state');
  if (!fs.lstatSync(directory).isDirectory()) return null;
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.some(entry => entry.name === 'openclaw.sqlite') ||
    entries.some(entry => !entry.isFile() || !DATABASE_FILES.has(entry.name))) return null;
  const root = fs.statSync(directory);
  const hash = createHash('sha256').update(JSON.stringify([fs.realpathSync(stateDir), root.dev, root.ino]));
  for (const entry of entries) {
    const bytes = fs.readFileSync(path.join(directory, entry.name));
    if ((entry.name.endsWith('-wal') || entry.name.endsWith('-journal')) && bytes.length !== 0) return null;
    hash.update(JSON.stringify([entry.name, bytes.length])).update(bytes);
  }
  const client = fingerprintClient(stateDir);
  return client === null ? null : hash.update(client).digest('hex');
}

export function recordBuilderNativeInitialState(stateDir: string, podUid: string | undefined): void {
  if (!podUid) return;
  const sha256 = fingerprint(stateDir);
  if (!sha256) throw new Error('Fresh Native host state is not closed and canonical');
  const file = path.join(stateDir, INITIAL_STATE), temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 2, podUid, sha256 }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function builderNativeInitialStateMatches(stateDir: string, podUid: string | undefined): boolean {
  if (!podUid) return false;
  try {
    const file = path.join(stateDir, INITIAL_STATE), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024) return false;
    const initial = JSON.parse(fs.readFileSync(file, 'utf8'));
    return initial?.version === 2 && initial.podUid === podUid &&
      typeof initial.sha256 === 'string' && /^[a-f0-9]{64}$/.test(initial.sha256) &&
      initial.sha256 === fingerprint(stateDir);
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
