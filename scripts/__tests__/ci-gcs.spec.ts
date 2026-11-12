import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from '../ci/gcs.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => 'fixture-credential\n') }));
const url = 'https://storage.googleapis.com/fixture';
const failed = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });
let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const settle = async <T>(promise: Promise<T>) => {
  const outcome = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  return outcome as Promise<{ value?: T; error?: Error & { cause?: unknown } }>;
};

it('returns a read that times out twice and then succeeds, logging both retries', async () => {
  const response = new Response('verified bytes');
  fetchMock.mockRejectedValueOnce(failed('ETIMEDOUT')).mockRejectedValueOnce(failed('ETIMEDOUT')).mockResolvedValueOnce(response);
  expect(await settle(request(url))).toEqual({ value: response });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[0][0])).toMatch(/attempt 1 of 6 failed \(ETIMEDOUT\)/);
  expect(String(warn.mock.calls[1][0])).toMatch(/attempt 2 of 6 failed \(ETIMEDOUT\)/);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-credential');
});
it.each(['EPIPE', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])('retries a read after %s', async code => {
  fetchMock.mockRejectedValueOnce(failed(code)).mockResolvedValueOnce(new Response('ok'));
  expect((await settle(request(url))).value?.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('recognizes a connect timeout reported through an aggregate of address attempts', async () => {
  const aggregate = Object.assign(new AggregateError([Object.assign(new Error('connect ETIMEDOUT 142.250.0.1:443'), { code: 'ETIMEDOUT' })]), { code: 'ETIMEDOUT' });
  fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: aggregate })).mockResolvedValueOnce(new Response('ok'));
  expect((await settle(request(url))).value?.status).toBe(200);
});
it('throws after the bound with the original error as the cause', async () => {
  const original = failed('ETIMEDOUT');
  fetchMock.mockRejectedValue(original);
  const { error } = await settle(request(url));
  expect(error?.message).toMatch(/failed after 6 attempts: ETIMEDOUT/);
  expect(error?.cause).toBe(original);
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(warn).toHaveBeenCalledTimes(5);
});
it.each([429, 500, 502, 503, 504])('retries a read answered %i', async status => {
  const response = new Response('ok');
  fetchMock.mockResolvedValueOnce(new Response('busy', { status })).mockResolvedValueOnce(response);
  expect(await settle(request(url))).toEqual({ value: response });
  expect(String(warn.mock.calls[0][0])).toContain(`HTTP ${status}`);
});
it('returns the last transient answer after the bound so the caller reports its status', async () => {
  fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
  expect((await settle(request(url))).value?.status).toBe(503);
  expect(fetchMock).toHaveBeenCalledTimes(6);
});
it.each([400, 401, 403, 404, 412])('does not retry a read answered %i', async status => {
  const response = new Response('no', { status });
  fetchMock.mockResolvedValueOnce(response);
  expect(await settle(request(url))).toEqual({ value: response });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});
it('propagates a failure that is not transient without retrying', async () => {
  const original = failed('ENOTFOUND');
  fetchMock.mockRejectedValueOnce(original);
  expect((await settle(request(url))).error).toBe(original);
  expect(fetchMock).toHaveBeenCalledOnce();
});
it.each(['POST', 'PATCH', 'DELETE'])('does not repeat an uncertain %s mutation', async method => {
  fetchMock.mockRejectedValue(failed('EPIPE'));
  expect((await settle(request(url, { method }))).error?.message).toBe('fetch failed');
  fetchMock.mockResolvedValue(new Response('busy', { status: 503 }));
  expect((await settle(request(url, { method }))).value?.status).toBe(503);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('does not retry an aborted read', async () => {
  const controller = new AbortController(); controller.abort();
  fetchMock.mockRejectedValue(failed('EPIPE'));
  expect((await settle(request(url, { signal: controller.signal }))).error?.message).toBe('fetch failed');
  expect(fetchMock).toHaveBeenCalledOnce();
});
