import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { verifyOtp: vi.fn(), exchangeCodeForSession: vi.fn() };
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServer: async () => ({ auth }) }));

const { GET } = await import("./route");

const origin = "http://127.0.0.1:3000";
const get = (query: string) => GET(new NextRequest(`${origin}/auth/confirm?${query}`));
const ok = { data: {}, error: null };
const bad = { data: {}, error: { code: "otp_expired", message: "Token has expired" } };

describe("GET /auth/confirm", () => {
  beforeEach(() => {
    auth.verifyOtp.mockReset().mockResolvedValue(ok);
    auth.exchangeCodeForSession.mockReset().mockResolvedValue(ok);
  });

  it.each(["signup", "recovery", "invite", "email_change"])(
    "verifies a %s token_hash and redirects to next",
    async (type) => {
      const res = await get(`token_hash=h1&type=${type}&next=/reset-password`);
      expect(auth.verifyOtp).toHaveBeenCalledWith({ type, token_hash: "h1" });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/reset-password");
    },
  );

  it("exchanges a PKCE code and redirects to next", async () => {
    const res = await get("code=c1&next=/onboarding");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("c1");
    expect(res.headers.get("location")).toBe("/onboarding");
  });

  // #121: hosted projects without custom SMTP keep Supabase's default templates, whose
  // {{ .ConfirmationURL }} verifies on Supabase and redirects to the redirectTo the app passed
  // (signup/actions.ts, forgot-password/actions.ts) with the PKCE `code` appended and no type.
  it.each([
    ["signup", "/auth/confirm?next=/onboarding", "/onboarding"],
    ["recovery", "/auth/confirm?next=/reset-password", "/reset-password"],
  ])(
    "a default-template %s link (code, no type) signs in and lands on next",
    async (_, to, next) => {
      const res = await GET(new NextRequest(`${origin}${to}&code=4c1e5a1b-pkce`));
      expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("4c1e5a1b-pkce");
      expect(auth.verifyOtp).not.toHaveBeenCalled();
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(next);
    },
  );

  it("sends an invalid or expired link to /login with a notice", async () => {
    auth.verifyOtp.mockResolvedValue(bad);
    const res = await get("token_hash=old&type=recovery&next=/reset-password");
    expect(res.headers.get("location")).toBe("/login?notice=link");
    auth.exchangeCodeForSession.mockResolvedValue(bad);
    expect((await get("code=old")).headers.get("location")).toBe("/login?notice=link");
  });

  it("sends a link with no token, or an unknown type, to /login", async () => {
    expect((await get("next=/stations")).headers.get("location")).toBe("/login?notice=link");
    expect((await get("token_hash=h1&type=bogus")).headers.get("location")).toBe(
      "/login?notice=link",
    );
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it.each(["https://evil.test/x", "//evil.test/x", "/\\evil.test", "/a/..//evil.test"])(
    "refuses off-origin next %s and lands on the type's own page",
    async (next) => {
      const res = await get(`token_hash=h1&type=recovery&next=${encodeURIComponent(next)}`);
      expect(res.headers.get("location")).toBe("/reset-password");
    },
  );
});
