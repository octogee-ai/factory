export async function mainBuild(options, deps) {
  if (options.desktop) throw new Error('Desktop builds use the explicit desktop Actions job');
  if (options.branch !== 'main' || !/^[a-f0-9]{40}$/.test(options.sourceSha)
      || options.checkoutSha !== options.sourceSha || !options.clean) {
    throw new Error('Main builds require a clean checkout of the selected main commit');
  }
  const existing = await deps.lookup();
  if (existing) return existing;
  return deps.lock(async () => {
    const winner = await deps.lookup();
    if (winner) return winner;
    await deps.images();
    await deps.frontend();
    return deps.publish();
  });
}

export function trackSubmission(submit, activeBuilds) {
  const pending = Symbol('unconfirmed Cloud Build submission');
  activeBuilds.add(pending);
  const id = submit();
  if (!id) throw new Error('Cloud Build did not return a build ID; writer lock retained');
  activeBuilds.add(id);
  activeBuilds.delete(pending);
  return id;
}

export function desktopRunId(value) {
  if (typeof value !== 'string' || !/^\d+-\d+$/.test(value)) throw new Error('Desktop builds require an Actions run ID and attempt');
  return value;
}
