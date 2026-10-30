// #116 /auth/confirm against the local Supabase: real token_hash values from the admin
// generateLink API (what the email templates put in the link) verified through the route
// with a cookie-backed server client, the same wiring as lib/supabase/server.ts.
import { serverClient } from "db";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  localSupabase,
  serviceRoleClient,
} from "../../../../../packages/db/src/testing/local-supabase";

const jar = new Map<string, string>();
const env = () => ({ url: localSupabase().API_URL, anonKey: localSupabase().ANON_KEY });
const sessionClient = () =>
  serverClient(env(), {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (list) => {
      for (const { name, value } of list) {
        if (value) jar.set(name, value);
        else jar.delete(name);
      }
    },
  });
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServer: async () => sessionClient() }));

const { GET } = await import("./route");

const admin = serviceRoleClient();
const userIds: string[] = [];
const origin = "http://127.0.0.1:3000";
const confirm = (query: Record<string, string>) =>
  GET(new NextRequest(`${origin}/auth/confirm?${new URLSearchParams(query)}`));

async function link(type: "signup" | "recovery"): Promise<{ email: string; tokenHash: string }> {
  const email = `${randomUUID()}@test.filletry`;
  const password = randomBytes(24).toString("hex");
  if (type === "recovery") {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    userIds.push(data.user.id);
  }
  const { data, error } =
    type === "signup"
      ? await admin.auth.admin.generateLink({ type, email, password })
      : await admin.auth.admin.generateLink({ type, email });
  if (error) throw error;
  if (type === "signup") userIds.push(data.user.id);
  return { email, tokenHash: data.properties.hashed_token };
}

async function sessionEmail(): Promise<string | null> {
  const { data } = await sessionClient().auth.getUser();
  return data.user?.email ?? null;
}

describe("/auth/confirm with real token_hash links", () => {
  beforeEach(() => jar.clear());
  afterAll(async () => {
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
  });

  it.each(["signup", "recovery"] as const)(
    "a valid %s token_hash signs in and redirects to next",
    async (type) => {
      const { email, tokenHash } = await link(type);
      const res = await confirm({ token_hash: tokenHash, type, next: "/reset-password" });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/reset-password");
      expect(await sessionEmail()).toBe(email);
    },
  );

  it("a used token_hash goes to /login with a notice and no session", async () => {
    const { tokenHash } = await link("recovery");
    await confirm({ token_hash: tokenHash, type: "recovery" });
    jar.clear();
    const res = await confirm({ token_hash: tokenHash, type: "recovery" });
    expect(res.headers.get("location")).toBe("/login?notice=link");
    expect(await sessionEmail()).toBeNull();
  });

  it("an invalid token_hash goes to /login with a notice and no session", async () => {
    const res = await confirm({ token_hash: "0".repeat(56), type: "signup", next: "/onboarding" });
    expect(res.headers.get("location")).toBe("/login?notice=link");
    expect(await sessionEmail()).toBeNull();
  });

  it("an off-origin next is refused even when the link is valid", async () => {
    const { tokenHash } = await link("recovery");
    const res = await confirm({ token_hash: tokenHash, type: "recovery", next: "//evil.test" });
    expect(res.headers.get("location")).toBe("/reset-password");
  });
});
