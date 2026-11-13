const MAX_TRACKED_KEYS = 4096;
function admitted(suppressed) {
    if (suppressed === 0)
        return { suppressed, note: "" };
    return { suppressed, note: ` (${suppressed} ${suppressed === 1 ? "repeat" : "repeats"} suppressed)` };
}
export function createRepeatSquelch(options) {
    const now = options.now ?? (() => Date.now());
    const tracked = new Map();
    const report = (key, value, suppressed) => {
        tracked.delete(key);
        if (tracked.size >= MAX_TRACKED_KEYS)
            tracked.delete(tracked.keys().next().value);
        tracked.set(key, { value, reportedAt: now(), suppressed: 0 });
        return admitted(suppressed);
    };
    return {
        admit(key, value = "") {
            const current = tracked.get(key);
            if (!current || current.value !== value || now() - current.reportedAt >= options.windowMs) {
                return report(key, value, current?.suppressed ?? 0);
            }
            current.suppressed += 1;
            return null;
        },
        settle(key) {
            const current = tracked.get(key);
            if (!current)
                return null;
            tracked.delete(key);
            return admitted(current.suppressed);
        },
    };
}
