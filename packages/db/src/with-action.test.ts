import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database, Json } from "./types";
import { withAction } from "./with-action";

// A fake PostgREST: GET /action_log answers from an in-memory log; RPCs record there
// atomically, like the SQL functions do.
function fakeClient() {
  const log = new Map<string, Json>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    let body: Json = null;
    if (url.pathname.endsWith("/action_log")) {
      const id = url.searchParams.get("client_action_id")?.replace(/^eq\./, "") ?? "";
      // maybeSingle() fetches a list and checks the cardinality client-side.
      body = log.has(id)
        ? [{ result: log.get(id) ?? null, completed_at: "2026-10-26T00:00:00Z" }]
        : [];
    } else {
      const args = JSON.parse(String(init?.body ?? "{}")) as { p_client_action_id: string };
      const result = { site_id: `site-for-${args.p_client_action_id}` };
      log.set(args.p_client_action_id, result);
      body = result;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = createClient<Database>("http://fake.local", "anon", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  return { client, log };
}

describe("withAction", () => {
  it("passes the action id to fn and returns its result", async () => {
    const { client } = fakeClient();
    const fn = vi.fn(async (id: string) => {
      const { data } = await client.rpc("admin_create_site", {
        p_client_action_id: id,
        p_name: "Dock",
      });
      return data;
    });
    await expect(withAction(client, "act-00000001", fn)).resolves.toEqual({
      site_id: "site-for-act-00000001",
    });
    expect(fn).toHaveBeenCalledWith("act-00000001");
  });

  it("answers a completed id from action_log without calling fn", async () => {
    const { client, log } = fakeClient();
    log.set("act-00000002", { site_id: "stored" });
    const fn = vi.fn(async () => ({ site_id: "new" }));
    await expect(withAction(client, "act-00000002", fn)).resolves.toEqual({ site_id: "stored" });
    expect(fn).not.toHaveBeenCalled();
  });
});

it("preserves lookup error codes so callers can distinguish permanent failures", async () => {
  const client = createClient<Database>("http://fake.local", "anon", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async () =>
        new Response(JSON.stringify({ code: "42501", message: "permission denied" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    },
  });
  const fn = vi.fn(async () => ({ ok: true }));
  await expect(withAction(client, "act-denied-001", fn)).rejects.toMatchObject({
    cause: { code: "42501" },
  });
  expect(fn).not.toHaveBeenCalled();
});
