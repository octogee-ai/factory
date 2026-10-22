import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import { bootFreshBuilderHost } from '../lib/builder-native-bootstrap.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each([0, 1, null])('requires a successful Native process close after readiness: %s', async (code) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-native-process-'));
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', code, code === null ? 'SIGKILL' : null)); return true; }),
  });
  spawn.mockReturnValue(child);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  try {
    const result = bootFreshBuilderHost(root, { HOME: root });
    if (code === 0) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow('native initialization exited');
    expect(spawn.mock.calls[0][2].env.OPENCLAW_NO_RESPAWN).toBe('1');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
