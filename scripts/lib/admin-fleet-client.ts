export interface AdminFleetRequest {
  method: "DELETE" | "PATCH" | "POST";
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface AdminFleetClient {
  request<T>(request: AdminFleetRequest): Promise<T>;
}

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "statusText" | "text">>;

export class AdminFleetHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    statusText: string,
  ) {
    const statusSuffix = statusText ? ` ${statusText}` : "";
    super(`Admin fleet request failed: ${status}${statusSuffix}`);
    this.name = "AdminFleetHttpError";
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function apiUrl(apiOrigin: string, path: string): string {
  return `${apiOrigin.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export function createAdminFleetClient(input: {
  apiOrigin: string;
  getIdToken: () => Promise<string>;
  fetchImpl?: FetchLike;
}): AdminFleetClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async request<T>(request: AdminFleetRequest): Promise<T> {
      const idToken = await input.getIdToken();
      const response = await fetchImpl(apiUrl(input.apiOrigin, request.path), {
        method: request.method,
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
          ...(request.idempotencyKey
            ? { "Idempotency-Key": request.idempotencyKey }
            : {}),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const text = await response.text();
      const body = parseJson(text);
      if (!response.ok) {
        throw new AdminFleetHttpError(response.status, body, response.statusText);
      }
      return body as T;
    },
  };
}

export async function exchangeAdminFleetCustomToken(input: {
  operatorUid: string;
  webApiKey: string;
  createCustomToken: (uid: string) => Promise<string>;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const customToken = await input.createCustomToken(input.operatorUid);
  const response = await fetchImpl(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(input.webApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    const statusSuffix = response.statusText ? ` ${response.statusText}` : "";
    const detailSuffix = detail ? ` ${detail}` : "";
    throw new Error(
      `Custom-token exchange failed: ${response.status}${statusSuffix}${detailSuffix}`,
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { idToken?: unknown }).idToken !== "string" ||
    (body as { idToken: string }).idToken.length === 0
  ) {
    throw new Error("Custom-token exchange returned no idToken");
  }
  return (body as { idToken: string }).idToken;
}
