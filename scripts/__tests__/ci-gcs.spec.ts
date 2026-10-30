import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from '../ci/gcs.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => 'fixture-credential\n') }));
const url = 'https://storage.googleapis.com/fixture';
const closed = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error('connection closed'), { code }) });
let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'])('retries an idempotent cloud read once after %s', async code => {
  const response = new Response('verified bytes');
  fetchMock.mockRejectedValueOnce(closed(code)).mockResolvedValueOnce(response);
  await expect(request(url)).resolves.toBe(response);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-credential');
});
it('fails after a second lost connection instead of retrying without a bound', async () => {
  fetchMock.mockRejectedValue(closed('EPIPE'));
  await expect(request(url)).rejects.toThrow('fetch failed');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it.each(['POST', 'PATCH', 'DELETE'])('does not repeat an uncertain %s mutation', async method => {
  fetchMock.mockRejectedValue(closed('EPIPE'));
  await expect(request(url, { method })).rejects.toThrow('fetch failed');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('does not retry an aborted read', async () => {
  const controller = new AbortController(); controller.abort();
  fetchMock.mockRejectedValue(closed('EPIPE'));
  await expect(request(url, { signal: controller.signal })).rejects.toThrow('fetch failed');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('propagates other failures and HTTP errors unchanged', async () => {
  fetchMock.mockRejectedValueOnce(closed('ENOTFOUND'));
  await expect(request(url)).rejects.toThrow('fetch failed');
  const response = new Response('denied', { status: 403 });
  fetchMock.mockResolvedValueOnce(response);
  await expect(request(url)).resolves.toBe(response);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(warn).not.toHaveBeenCalled();
});
