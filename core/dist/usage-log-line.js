export function formatUsageLogLine(f) {
    const slug = f.workspaceId ? ` slug:${f.workspaceId}` : "";
    return (`✓ usage: ${f.totalTokens} tokens ($${f.costUsd.toFixed(4)}) ` +
        `[${f.role}/${f.model}] uid:${f.uid.slice(0, 8)}${slug}`);
}
