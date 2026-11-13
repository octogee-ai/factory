import { describe, expect, it, vi } from "vitest";
import { isUserCredentialRejected, mattermostBearerVerifier, UserCredentialRejected } from "./user-identity-provider.js";

const MATTERMOST_URL = "http://mattermost.internal:8065";
const SESSION = "abcdefghijklmnopqrstuvwxyz";
const OTHER_SESSION = "zyxwvutsrqponmlkjihgfedcba";

type FetchCall = [string, RequestInit];

function answer(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mattermostAnswering(...answers: Array<Response | Error>) {
  const queue = [...answers];
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("no more Mattermost answers queued");
    if (next instanceof Error) throw next;
    return next;
  });
}

function platformUsers(byMattermostId: Record<string, string>) {
  return {
    findByMattermostUserId: vi.fn(async (mattermostUserId: string) => {
      const uid = byMattermostId[mattermostUserId];
      return uid === undefined ? null : ({ uid } as never);
    }),
  };
}

function verifierWith(fetch: ReturnType<typeof mattermostAnswering>, users = platformUsers({ "mm-lin": "uid-lin" }), now = () => 1_000_000) {
  return { verify: mattermostBearerVerifier({ mattermostUrl: MATTERMOST_URL, users, fetch: fetch as unknown as typeof globalThis.fetch, now }), users };
}

describe("verifying a Mattermost session as a platform user", () => {
  it("asks Mattermost who holds the session and answers with the platform user provisioned for that account", async () => {
    const fetch = mattermostAnswering(answer(200, { id: "mm-lin", delete_at: 0 }));
    const { verify } = verifierWith(fetch);

    await expect(verify(SESSION)).resolves.toEqual({ uid: "uid-lin", authTime: null });

    const [url, init] = fetch.mock.calls[0] as FetchCall;
    expect(url).toBe(`${MATTERMOST_URL}/api/v4/users/me`);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${SESSION}`);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("joins the configured URL without doubling a trailing slash", async () => {
    const fetch = mattermostAnswering(answer(200, { id: "mm-lin", delete_at: 0 }));
    const verify = mattermostBearerVerifier({
      mattermostUrl: `${MATTERMOST_URL}/`,
      users: platformUsers({ "mm-lin": "uid-lin" }),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await verify(SESSION);

    expect((fetch.mock.calls[0] as FetchCall)[0]).toBe(`${MATTERMOST_URL}/api/v4/users/me`);
  });

  it("trusts only the Mattermost user id: username, email and a system admin role change nothing", async () => {
    const fetch = mattermostAnswering(answer(200, {
      id: "mm-lin",
      delete_at: 0,
      username: "ada",
      email: "ada@example.com",
      roles: "system_admin system_user",
    }));
    const { verify, users } = verifierWith(fetch, platformUsers({ "mm-lin": "uid-lin", "mm-ada": "uid-ada" }));

    await expect(verify(SESSION)).resolves.toEqual({ uid: "uid-lin", authTime: null });
    expect(users.findByMattermostUserId).toHaveBeenCalledWith("mm-lin");
    expect(users.findByMattermostUserId).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a JWT", "header.payload.signature"],
    ["an empty bearer", ""],
    ["a bearer with upper case", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    ["a bearer of the wrong length", "abcdefghijklmnopqrstuvwxy"],
  ])("rejects %s without asking Mattermost", async (_name, bearer) => {
    const fetch = mattermostAnswering();
    const { verify } = verifierWith(fetch);

    await expect(verify(bearer)).rejects.toBeInstanceOf(UserCredentialRejected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a session Mattermost does not accept", async () => {
    const { verify } = verifierWith(mattermostAnswering(answer(401, { id: "api.context.session_expired.app_error" })));

    await expect(verify(SESSION)).rejects.toBeInstanceOf(UserCredentialRejected);
  });

  it("rejects a bot account's token", async () => {
    const { verify, users } = verifierWith(mattermostAnswering(answer(200, { id: "mm-lin", delete_at: 0, is_bot: true })));

    await expect(verify(SESSION)).rejects.toThrow(UserCredentialRejected);
    expect(users.findByMattermostUserId).not.toHaveBeenCalled();
  });

  it("rejects a deactivated Mattermost account", async () => {
    const { verify } = verifierWith(mattermostAnswering(answer(200, { id: "mm-lin", delete_at: 1_700_000_000_000 })));

    await expect(verify(SESSION)).rejects.toBeInstanceOf(UserCredentialRejected);
  });

  it("rejects a Mattermost account the platform has no user for", async () => {
    const { verify } = verifierWith(mattermostAnswering(answer(200, { id: "mm-stranger", delete_at: 0 })));

    await expect(verify(SESSION)).rejects.toThrow("no platform user has this Mattermost account");
  });

  it.each([
    ["a server error", () => answer(503)],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "http://elsewhere.example/" } })],
    ["an answer without a user id", () => answer(200, { delete_at: 0 })],
    ["an answer without a deactivation time", () => answer(200, { id: "mm-lin" })],
    ["an answer that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("reports Mattermost as unavailable, not the session as invalid, on %s", async (_name, response) => {
    const { verify } = verifierWith(mattermostAnswering(response()));

    const failure = await verify(SESSION).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UserCredentialRejected);
  });

  it("reports a timeout as Mattermost being unavailable", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { verify } = verifierWith(mattermostAnswering(timeout));

    const failure = await verify(SESSION).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(UserCredentialRejected);
    expect((failure as Error).message).toContain("did not answer");
  });

  it("reports a connection failure as Mattermost being unavailable", async () => {
    const { verify } = verifierWith(mattermostAnswering(new TypeError("fetch failed")));

    const failure = await verify(SESSION).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(UserCredentialRejected);
    expect((failure as Error).message).toContain("fetch failed");
  });

  it("refuses to start without an http or https Mattermost URL", () => {
    const users = platformUsers({});
    expect(() => mattermostBearerVerifier({ mattermostUrl: "", users })).toThrow("Mattermost URL");
    expect(() => mattermostBearerVerifier({ mattermostUrl: "file:///etc/passwd", users })).toThrow("Mattermost URL");
  });
});

describe("remembering verified Mattermost sessions", () => {
  it("answers a session again from memory for 60 seconds, then asks Mattermost again", async () => {
    let clock = 1_000_000;
    const fetch = mattermostAnswering(
      answer(200, { id: "mm-lin", delete_at: 0 }),
      answer(401),
    );
    const { verify } = verifierWith(fetch, undefined, () => clock);

    await verify(SESSION);
    clock += 59_999;
    await expect(verify(SESSION)).resolves.toEqual({ uid: "uid-lin", authTime: null });
    expect(fetch).toHaveBeenCalledTimes(1);

    clock += 1;
    await expect(verify(SESSION)).rejects.toBeInstanceOf(UserCredentialRejected);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never remembers a rejection", async () => {
    const fetch = mattermostAnswering(answer(401), answer(200, { id: "mm-lin", delete_at: 0 }));
    const { verify } = verifierWith(fetch);

    await expect(verify(SESSION)).rejects.toBeInstanceOf(UserCredentialRejected);
    await expect(verify(SESSION)).resolves.toEqual({ uid: "uid-lin", authTime: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never remembers a session whose Mattermost account has no platform user", async () => {
    const fetch = mattermostAnswering(answer(200, { id: "mm-lin", delete_at: 0 }), answer(200, { id: "mm-lin", delete_at: 0 }));
    const users = platformUsers({});
    const { verify } = verifierWith(fetch, users);

    await expect(verify(SESSION)).rejects.toBeInstanceOf(UserCredentialRejected);
    await expect(verify(SESSION)).rejects.toBeInstanceOf(UserCredentialRejected);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps each session's answer separate", async () => {
    const fetch = mattermostAnswering(
      answer(200, { id: "mm-lin", delete_at: 0 }),
      answer(200, { id: "mm-ada", delete_at: 0 }),
    );
    const { verify } = verifierWith(fetch, platformUsers({ "mm-lin": "uid-lin", "mm-ada": "uid-ada" }));

    await expect(verify(SESSION)).resolves.toMatchObject({ uid: "uid-lin" });
    await expect(verify(OTHER_SESSION)).resolves.toMatchObject({ uid: "uid-ada" });
  });

  it("holds at most 5000 sessions, dropping the least recently used", async () => {
    const tokens = Array.from({ length: 5001 }, (_, index) => index.toString(36).padStart(26, "0"));
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("authorization")!.slice("Bearer ".length);
      return answer(200, { id: `mm-${token}`, delete_at: 0 });
    });
    const users = { findByMattermostUserId: vi.fn(async (id: string) => ({ uid: `uid-${id}` }) as never) };
    const verify = mattermostBearerVerifier({ mattermostUrl: MATTERMOST_URL, users, fetch: fetch as unknown as typeof globalThis.fetch });

    for (const token of tokens) await verify(token);
    expect(fetch).toHaveBeenCalledTimes(5001);

    await verify(tokens[5000]!);
    await verify(tokens[1]!);
    expect(fetch).toHaveBeenCalledTimes(5001);

    await verify(tokens[0]!);
    expect(fetch).toHaveBeenCalledTimes(5002);
  });
});

describe("recognizing a rejected credential", () => {
  it("recognizes a rejection raised by any copy of this module", () => {
    const fromAnotherCopy = Object.assign(new Error("rejected elsewhere"), { name: "UserCredentialRejected" });

    expect(isUserCredentialRejected(new UserCredentialRejected("rejected"))).toBe(true);
    expect(isUserCredentialRejected(fromAnotherCopy)).toBe(true);
  });

  it("does not mistake an outage for a rejection", () => {
    expect(isUserCredentialRejected(new Error("Mattermost answered the session check with HTTP 503"))).toBe(false);
    expect(isUserCredentialRejected("UserCredentialRejected")).toBe(false);
  });
});
