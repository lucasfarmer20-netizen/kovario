// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNUP_SENT } from "@/lib/auth-messages";

const mocks = vi.hoisted(() => ({ signUp: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({ auth: { signUp: mocks.signUp } }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://app.test" }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const { signUp } = await import("./actions");
const { SignupSent } = await import("./signup-form");

const form = (email: string, password = "correct horse") => {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
};

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

describe("#116 signup never reveals an existing account", () => {
  it("a new email (confirmation on) and an existing one get the same answer", async () => {
    mocks.signUp.mockResolvedValueOnce({ data: { user: {}, session: null }, error: null });
    const fresh = await signUp({}, form("new@plant.test"));
    // Confirmation off: Supabase says so outright; the form must not pass it on.
    mocks.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: "user_already_exists", message: "User already registered" },
    });
    const existing = await signUp({}, form("owner@plant.test"));
    expect(fresh).toEqual({ ok: SIGNUP_SENT });
    expect(existing).toEqual(fresh);
  });

  it("the confirmation link goes through /auth/confirm to /onboarding", async () => {
    mocks.signUp.mockResolvedValue({ data: { user: {}, session: null }, error: null });
    await signUp({}, form("new@plant.test"));
    expect(mocks.signUp.mock.calls[0]![0].options.emailRedirectTo).toBe(
      "https://app.test/auth/confirm?next=/onboarding",
    );
  });

  it("refuses a password over 72 characters (same rule as reset)", async () => {
    const res = await signUp({}, form("new@plant.test", "x".repeat(73)));
    expect(res.error).toBeDefined();
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it("the success text links to sign in and to reset the password", () => {
    render(<SignupSent message={SIGNUP_SENT} />);
    expect(screen.getByText(SIGNUP_SENT)).toBeTruthy();
    expect(screen.getByText(/Already have an account\?/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: "reset your password" }).getAttribute("href")).toBe(
      "/forgot-password",
    );
  });
});
