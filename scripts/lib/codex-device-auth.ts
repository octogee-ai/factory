export interface CodexDeviceAuth {
  verificationUrl: string;
  userCode: string;
  expiresInMinutes: number | null;
}

/**
 * Parse `codex login --device-auth` stdout into the actionable bits a UI
 * surfaces — the verification URL and the one-time user code. This is the
 * heart of "Octogee is the device": the headless half runs server-side,
 * the user only opens the URL + enters the code. Tolerant of ANSI colour
 * codes and of partially-stripped output (lone ESC bytes). Returns null
 * when the input isn't a device-auth prompt (not actionable).
 */
export function parseCodexDeviceAuth(stdout: string): CodexDeviceAuth | null {
  if (!stdout) return null;
  // Strip terminal colour codes. Matching the ANSI ESC (0x1b) is the
  // explicit, correct intent (not a stray-control-char bug) — the only
  // reliable way to remove CSI sequences + lone ESC from imperfectly
  // colour-stripped output.
  const clean = stdout
    // eslint-disable-next-line no-control-regex -- intentional ANSI CSI strip
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentional lone ESC strip
    .replace(/\x1b/g, "");

  const url = clean.match(/https?:\/\/[^\s]*device[^\s]*/i);
  const code = clean.match(/\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/);
  if (!url || !code) return null;

  const exp = clean.match(/expires in (\d+)\s*minutes?/i);
  return {
    verificationUrl: url[0],
    userCode: code[0],
    expiresInMinutes: exp ? Number(exp[1]) : null,
  };
}
