// A scriptable fake of the Shippo API for tests (CI uses fakes for shipping — docs/09).
// Routes match on method + URL; a reply list is played in order and its last entry repeats.
// Every call is recorded (URL, method, whether the Shippo token was sent) so tests can assert
// what was — and was not — called.
import type { FetchLike } from "./shippo.ts";

export type FakeReply = { status?: number; json?: unknown; text?: string };
export type FakeRoute = {
  method?: "GET" | "POST";
  /** Substring of the URL, or a regex over it. */
  url: string | RegExp;
  reply: FakeReply | FakeReply[];
};
export type FakeCall = { method: string; url: string; authorized: boolean; body: unknown };

export type FakeFetch = FetchLike & {
  calls: FakeCall[];
  count: (url: string | RegExp, method?: string) => number;
};

export function fakeFetch(routes: FakeRoute[]): FakeFetch {
  const played = new Map<FakeRoute, number>();
  const calls: FakeCall[] = [];
  const matches = (pattern: string | RegExp, url: string) =>
    typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);

  const fn = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, authorized: headers.has("authorization"), body });
    const route = routes.find((r) => (r.method ?? method) === method && matches(r.url, url));
    if (!route)
      return new Response(JSON.stringify({ detail: `no fake for ${method} ${url}` }), {
        status: 404,
      });
    const list = Array.isArray(route.reply) ? route.reply : [route.reply];
    const n = played.get(route) ?? 0;
    played.set(route, n + 1);
    const reply = list[Math.min(n, list.length - 1)]!;
    const text = reply.text ?? JSON.stringify(reply.json ?? {});
    return new Response(text, { status: reply.status ?? 200 });
  }) as FakeFetch;

  fn.calls = calls;
  fn.count = (url, method) =>
    calls.filter((c) => matches(url, c.url) && (!method || c.method === method)).length;
  return fn;
}
