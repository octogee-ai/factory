import { latestBrowserTabCards } from 'openclaw-browser-resources';
export function latestNativeBrowserTab(messages: readonly unknown[], profile: string) {
  const values = [...latestBrowserTabCards(messages, []).values()];
  return values.filter(value => value.tab.target === 'host' && value.tab.profile === profile).at(-1) ?? null;
}
