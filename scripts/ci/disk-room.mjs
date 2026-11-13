import { existsSync, readFileSync } from 'node:fs';

export async function awaitDiskRoom(marker, {
  exists = existsSync,
  read = path => readFileSync(path, 'utf8'),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 600_000,
} = {}) {
  if (!marker) return null;
  const deadline = now() + timeoutMs;
  while (!exists(marker)) {
    if (now() >= deadline) throw new Error(`Disk cleanup did not finish within ${timeoutMs / 1000}s (${marker})`);
    await sleep(2_000);
  }
  const status = read(marker).trim();
  const report = exists(`${marker}.log`) ? read(`${marker}.log`) : '';
  if (status !== '0') throw new Error(`Disk cleanup failed with status ${status}\n${report}`);
  return report;
}
