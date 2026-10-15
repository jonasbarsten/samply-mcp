/** A non-2xx answer from Samply. The body is kept short and is shown to the model, never logged. */
export class SamplyError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Samply ${status}`);
    this.body = body.slice(0, 500);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Query = Record<string, string | number | boolean | undefined>;

export interface SamplyClient {
  /** GET `path` and parse JSON. */
  get<T>(path: string, query?: Query): Promise<T>;
  /** POST a JSON body (Samply creates and updates with POST) and parse the JSON answer. */
  post<T>(path: string, body: unknown): Promise<T>;
  /** DELETE `path`; resolves with the parsed JSON answer (Samply answers `{}`). */
  delete<T>(path: string): Promise<T>;
}

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Every Samply call goes through here: the bearer token is set here and nowhere else, so it never
 * goes to a host other than `baseUrl`. Samply documents no rate limit; a 429 is retried once after
 * a second. `onWrite` fires after any successful non-GET, for the write guard in the MCP routes.
 */
export function createSamplyClient(opts: { baseUrl: string; accessToken: string; fetch: typeof fetch; onWrite?: () => void }): SamplyClient {
  async function once(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${opts.accessToken}`);
    headers.set("accept", "application/json");
    return opts.fetch(`${opts.baseUrl}${path}`, { ...init, headers });
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res = await once(path, init);
    if (res.status === 429) {
      await sleep(1000);
      res = await once(path, init);
    }
    if (!res.ok) throw new SamplyError(res.status, await res.text());
    if ((init?.method ?? "GET").toUpperCase() !== "GET") opts.onWrite?.();
    const text = await res.text();
    if (text.trim() === "") return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SamplyError(502, "Samply answered with something that is not JSON");
    }
  }

  return {
    get: (path, query) => request(withQuery(path, query)),
    post: (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    delete: (path) => request(path, { method: "DELETE" }),
  };
}
