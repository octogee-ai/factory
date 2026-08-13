const WARNING_PATTERN = /\b(?:auth-failed|denied|error|failed|failure|fatal|invalid|rejected|refused|timed out|timeout|unavailable|unsynchronized|threw)\b/iu;

export interface BridgeLogDependencies {
  now?: () => Date;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export function createBridgeLog(deps: BridgeLogDependencies = {}): (message: string) => void {
  const now = deps.now ?? (() => new Date());
  const info = deps.info ?? ((message: string) => console.log(message));
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  return (message: string): void => {
    const formatted = `${now().toISOString()} ${message}`;
    if (WARNING_PATTERN.test(message)) {
      warn(formatted);
      return;
    }
    info(formatted);
  };
}
