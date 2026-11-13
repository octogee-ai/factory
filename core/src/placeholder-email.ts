export const DEFAULT_PLACEHOLDER_EMAIL_DOMAIN = "users.invalid";

const DOMAIN_SLOT = Symbol.for("platform.placeholderEmailDomain");
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_NAME = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);

type DomainHost = typeof globalThis & { [DOMAIN_SLOT]?: string };

export function installPlaceholderEmailDomain(domain: string): void {
  if (!DOMAIN_NAME.test(domain)) throw new Error(`not a placeholder email domain: ${JSON.stringify(domain)}`);
  (globalThis as DomainHost)[DOMAIN_SLOT] = domain;
}

function placeholderEmailDomain(): string {
  return (globalThis as DomainHost)[DOMAIN_SLOT] ?? DEFAULT_PLACEHOLDER_EMAIL_DOMAIN;
}

export function placeholderEmail(localPart: string): string {
  return `${localPart}@${placeholderEmailDomain()}`;
}

export function isPlaceholderEmail(email: string): boolean {
  return email.endsWith(`@${placeholderEmailDomain()}`);
}
