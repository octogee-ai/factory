import { fetchWithRetry } from './transient-retry.mjs';

export async function readFirebaseInit(origin) {
  const url = `${origin}/__/firebase/init.json`;
  const response = await fetchWithRetry(`Firebase configuration ${url}`, url, undefined);
  if (!response.ok) throw new Error(`Firebase configuration ${url}: HTTP ${response.status}`);
  return response.json();
}
