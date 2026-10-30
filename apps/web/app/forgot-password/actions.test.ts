import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESET_SENT } from "@/lib/auth-messages";

const mocks = vi.hoisted(() => ({ resetPasswordForEmail: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    auth: { resetPasswordForEmail: mocks.resetPasswordForEmail },
  }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://app.test" }),
}));

const { requestPasswordReset } = await import("./actions");

const form = (email: string) => {
  const data = new FormData();
  data.set("email", email);
  return data;
};

beforeEach(() => vi.resetAllMocks());

describe("#116 forgot password", () => {
  it("sends the reset link through /auth/confirm to /reset-password", async () => {
    mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    expect(await requestPasswordReset({}, form("owner@plant.test"))).toEqual({ ok: RESET_SENT });
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith("owner@plant.test", {
      redirectTo: "https://app.test/auth/confirm?next=/reset-password",
    });
  });

  it.each([
    ["no account", { data: {}, error: null }],
    ["resend throttle", { data: {}, error: { code: "over_email_send_rate_limit", status: 429 } }],
    ["any other error", { data: {}, error: { code: "unexpected_failure", status: 500 } }],
  ])("answers the same with %s, so it never reveals an account", async (_label, result) => {
    mocks.resetPasswordForEmail.mockResolvedValue(result);
    expect(await requestPasswordReset({}, form("someone@plant.test"))).toEqual({ ok: RESET_SENT });
  });

  it("asks for an email when the field is not one", async () => {
    expect(await requestPasswordReset({}, form("nope"))).toEqual({ error: "Enter your email." });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});
