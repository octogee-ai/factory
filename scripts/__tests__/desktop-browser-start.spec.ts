import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const browser = fileURLToPath(new URL('../../infra/desktop/rootfs/usr/local/bin/octo-desktop-browser', import.meta.url));
const temporaryHomes: string[] = [];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'octo-browser-start-'));
  temporaryHomes.push(home);
  const bin = join(home, 'bin');
  const sessions = join(home, '.config/octogee-chromium/Default/Sessions');
  mkdirSync(bin);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(bin, 'chromium'), '#!/usr/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE_FILE"\n', { mode: 0o755 });
  return {
    home,
    sessions,
    launch(args: string[] = [], homepage?: string, noSandbox?: string) {
      const capture = join(home, 'arguments');
      execFileSync('bash', [browser, ...args], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CAPTURE_FILE: capture, OCTO_HOME_URL: homepage ?? '', OCTO_CHROMIUM_NO_SANDBOX: noSandbox },
        stdio: 'pipe',
      });
      return readFileSync(capture, 'utf8').trimEnd().split('\n');
    },
  };
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('desktop Chromium startup', () => {
  it.each([undefined, '0'])('keeps the Chromium sandbox enabled with opt-out %s', (value) => {
    expect(fixture().launch([], undefined, value)).not.toContain('--no-sandbox');
  });

  it('disables the sandbox only for the explicit development opt-out', () => {
    expect(fixture().launch([], undefined, '1').filter((arg) => arg === '--no-sandbox')).toHaveLength(1);
  });

  it.each(['', 'true', 'false', '2'])('rejects invalid sandbox opt-out %j before Chromium starts', (value) => {
    const state = fixture();
    expect(() => state.launch([], undefined, value)).toThrow('OCTO_CHROMIUM_NO_SANDBOX must be 0 or 1');
    expect(existsSync(join(state.home, 'arguments'))).toBe(false);
  });

  it('opens the homepage on first startup with the persistent loopback CDP profile', () => {
    const state = fixture();
    expect(state.launch()).toEqual(expect.arrayContaining([
      `--user-data-dir=${state.home}/.config/octogee-chromium`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
      '--start-maximized',
      '--restore-last-session',
      'https://octogee.com',
    ]));
  });

  it('restores a saved session without adding another homepage tab', () => {
    const state = fixture();
    writeFileSync(join(state.sessions, 'Session_123'), 'saved session');
    const args = state.launch();
    expect(args).toContain('--restore-last-session');
    expect(args.filter((arg) => !arg.startsWith('--'))).toEqual([]);
  });

  it('opens the configured homepage when only empty sessions or tab metadata exist', () => {
    const state = fixture();
    writeFileSync(join(state.sessions, 'Session_123'), '');
    writeFileSync(join(state.sessions, 'Tabs_456'), 'saved tab metadata');
    mkdirSync(join(state.sessions, 'Session_directory'));
    expect(state.launch([], 'https://app-test.octogee.com')).toContain('https://app-test.octogee.com');
  });

  it('passes explicit browser requests through without startup URLs or session restoration', () => {
    const state = fixture();
    const args = state.launch(['--new-tab', 'file:///home/octo/Documents/a%20page.html']);
    expect(args.slice(-2)).toEqual(['--new-tab', 'file:///home/octo/Documents/a%20page.html']);
    expect(args).not.toContain('--restore-last-session');
    expect(args).not.toContain('--start-maximized');
    expect(args).not.toContain('https://octogee.com');
  });
});
