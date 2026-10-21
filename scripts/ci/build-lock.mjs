import { randomUUID } from 'node:crypto';

async function releaseGeneration(request, url, label) {
  let result;
  try { result = await request(url, { method: 'DELETE' }); }
  catch { result = await request(url, { method: 'DELETE' }); }
  if (![204, 404].includes(result.status)) throw new Error(`${label} release failed: ${result.status}`);
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

export async function withBuildLock(sha, request, run, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), canRelease = () => true } = {}) {
  const object = encodeURIComponent(`main/${sha}.json`);
  const url = `https://storage.googleapis.com/storage/v1/b/octogee-ci-state/o/${object}`;
  const upload = `https://storage.googleapis.com/upload/storage/v1/b/octogee-ci-state/o?uploadType=media&name=${object}&ifGenerationMatch=0`;
  const deadline = now() + 3 * 60 * 60_000;
  const owner = randomUUID();
  let generation;
  while (!generation) {
    const created = await request(upload, { method: 'POST', body: JSON.stringify({ owner, createdAt: now(), buildId: process.env.BUILD_ID ?? null }) });
    if (created.status === 200) { generation = (await created.json()).generation; break; }
    if (created.status !== 412) throw new Error(`Build lock create failed: ${created.status} ${await created.text()}`);
    if (now() >= deadline) throw new Error(`Timed out waiting for main build ${sha}`);
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
