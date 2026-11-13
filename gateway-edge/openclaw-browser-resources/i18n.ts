import { en } from 'openclaw-english';
const dictionaries: Record<string, unknown> = en;
const listeners = new Set<() => void>();
export const DEFAULT_LOCALE = 'en' as const;
export const isSupportedLocale = (locale: unknown): locale is 'en' => locale === 'en';
export const SUPPORTED_LOCALES = ['en'] as const;
function registerTranslation(_locale: string, values: Record<string, unknown>) {
  Object.assign(dictionaries, values);
  for (const listener of [...listeners]) listener();
}
export const i18n = {
  getLocale: () => 'en' as const,
  registerTranslations: registerTranslation,
  registerTranslation,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  t,
  translateActive,
};
export function translateActive(key: string): string | undefined {
  let value: unknown = dictionaries;
  for (const part of key.split('.')) value = value && typeof value === 'object' ? Reflect.get(value, part) : undefined;
  return typeof value === 'string' ? value : undefined;
}
export function t(key: string, params?: Record<string, string | number>): string {
  const value = translateActive(key);
  if (value === undefined) throw new Error(`Missing native translation: ${key}`);
  return value.replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
}
export class I18nController { constructor(_host: unknown) {} }
