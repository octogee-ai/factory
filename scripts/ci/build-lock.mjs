import { randomUUID } from 'node:crypto';
import { fetchWithRetry } from './transient-retry.mjs';

async function releaseGeneration(request, url, label) {
  let result;
  try { result = await request(url, { method: 'DELETE' }); }
  catch { result = await request(url, { method: 'DELETE' }); }
  if (![204, 404].includes(result.status)) throw new Error(`${label} release failed: ${result.status}`);
}

export function githubRunOwner(env = process.env) {
  return env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
    ? { repository: env.GITHUB_REPOSITORY, id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT ?? '1' }
    : null;
}

export async function githubRunCompleted(run, { fetchRun = (url, init) => fetchWithRetry(`GitHub run lookup ${url}`, url, init), token = process.env.GH_TOKEN } = {}) {
  if (!token) throw new Error('GH_TOKEN is not set, so the holder run cannot be checked');
  const response = await fetchRun(`https://api.github.com/repos/${run.repository}/actions/runs/${run.id}/attempts/${run.attempt}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub run lookup returned ${response.status}`);
  return (await response.json()).status === 'completed';
}

async function takeOverFinishedHolder(request, url, runCompleted, stopHolderRun, label) {
  const metadata = await request(url, { method: 'GET' });
  if (metadata.status === 404) return true;
  if (metadata.status !== 200) throw new Error(`Build lock inspect failed: ${metadata.status}`);
  const { generation } = await metadata.json();
  const content = await request(`${url}?alt=media&ifGenerationMatch=${generation}`, { method: 'GET' });
  if ([404, 412].includes(content.status)) return true;
  if (content.status !== 200) throw new Error(`Build lock read failed: ${content.status}`);
  const holder = await content.json();
  if (!holder.run) return false;
  let finished;
  try { finished = await runCompleted(holder.run); }
  catch (error) {
    console.error(`${label} holder run ${holder.run.id} attempt ${holder.run.attempt} could not be checked (${error.message}); waiting`);
    return false;
  }
  if (!finished) return false;
  await stopHolderRun?.(holder.run);
  const removed = await request(`${url}?ifGenerationMatch=${generation}`, { method: 'DELETE' });
  if (removed.status === 204) {
    console.log(`Took over ${label}: holder run ${holder.run.id} attempt ${holder.run.attempt} has finished`);
    return true;
  }
  if ([404, 412].includes(removed.status)) return true;
  throw new Error(`Build lock takeover failed: ${removed.status}`);
}

async function createLockObject(request, upload, record) {
  const created = await request(upload, { method: 'POST', body: JSON.stringify(record) });
  if (created.status === 200) return (await created.json()).generation;
  if (created.status !== 412) throw new Error(`Build lock create failed: ${created.status} ${await created.text()}`);
  return null;
}

export async function withBuildPin(sha, request, run, { canRelease = () => true } = {}) {
  const object = encodeURIComponent(`main-pins/${sha}/${randomUUID()}.json`);
  console.log(`Local main pin: gs://octogee-ci-state/${decodeURIComponent(object)}`);
  const upload = `https://storage.googleapis.com/upload/storage/v1/b/octogee-ci-state/o?uploadType=media&name=${object}&ifGenerationMatch=0`;
  const created = await request(upload, { method: 'POST', body: JSON.stringify({ sourceSha: sha, createdAt: Date.now() }) });
  if (created.status !== 200) throw new Error(`Build pin create failed: ${created.status} ${await created.text()}`);
  const { generation } = await created.json();
  const release = async () => {
    if (canRelease()) {
      await releaseGeneration(request, `https://storage.googleapis.com/storage/v1/b/octogee-ci-state/o/${object}?ifGenerationMatch=${generation}`, 'Build pin');
    } else console.error(`Build pin retained: ${decodeURIComponent(object)}; verify every submitted child is terminal before operator recovery`);
  };
  return Promise.resolve().then(run).then(async value => { await release(); return value; }, async error => { await release(); throw error; });
}

export async function withBuildLock(sha, request, run, {
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), canRelease = () => true,
  takeOverFinishedRuns = false, runCompleted = githubRunCompleted, stopHolderRun, runOwner = githubRunOwner(),
} = {}) {
  const object = encodeURIComponent(`main/${sha}.json`);
  const url = `https://storage.googleapis.com/storage/v1/b/octogee-ci-state/o/${object}`;
  const upload = `https://storage.googleapis.com/upload/storage/v1/b/octogee-ci-state/o?uploadType=media&name=${object}&ifGenerationMatch=0`;
  const deadline = now() + 3 * 60 * 60_000;
  const record = { owner: randomUUID(), buildId: process.env.BUILD_ID ?? null, ...(runOwner ? { run: runOwner } : {}) };
  let generation;
  while (!generation) {
    generation = await createLockObject(request, upload, { ...record, createdAt: now() });
    if (generation) break;
    if (now() >= deadline) throw new Error(`Timed out waiting for main build ${sha}`);
    if (takeOverFinishedRuns && await takeOverFinishedHolder(request, url, runCompleted, stopHolderRun, `gs://octogee-ci-state/main/${sha}.json`)) continue;
    console.log(`Waiting for main build ${sha}`);
    await sleep(30_000);
  }
  const release = async () => {
    if (canRelease()) {
      await releaseGeneration(request, `${url}?ifGenerationMatch=${generation}`, 'Build lock');
    } else console.error(`Build lock retained: gs://octogee-ci-state/main/${sha}.json; verify all child builds are terminal before removing it`);
  };
  return run().then(async value => { await release(); return value; }, async error => { await release(); throw error; });
}
