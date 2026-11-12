import { execFileSync } from 'node:child_process';
import { fetchWithRetry, transientConnectionCode } from './transient-retry.mjs';

export const token = () => execFileSync(process.env.CI_GCLOUD_BIN ?? 'gcloud', ['auth', 'print-access-token', ...(process.env.CI_IMPERSONATE ? [`--impersonate-service-account=${process.env.CI_IMPERSONATE}`] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
export async function request(url, options = {}) {
  const init = { ...options, headers: { ...options.headers, Authorization: `Bearer ${token()}` } };
  const method = (options.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return fetch(url, init);
  const { origin, pathname } = new URL(url);
  return fetchWithRetry(`Cloud ${method} ${origin}${pathname}`, url, init, {
    transientError: error => options.signal?.aborted ? null : transientConnectionCode(error),
  });
}
export const objectUrl = (bucket, name) => `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
export async function readObject(bucket, name) {
  const response = await request(`${objectUrl(bucket, name)}?alt=media`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GCS read ${name}: ${response.status}`);
  return response;
}
export async function writeObject(bucket, name, body, { create = false, type = 'application/json' } = {}) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}${create ? '&ifGenerationMatch=0' : ''}`;
  const response = await request(url, { method: 'POST', headers: { 'Content-Type': type }, body });
  if (!response.ok) throw new Error(`GCS write ${name}: ${response.status} ${await response.text()}`);
  return response.json();
}
