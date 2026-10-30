import { beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_RULE } from "@/lib/auth-messages";

const mocks = vi.hoisted(() => ({ updateUser: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({ auth: { updateUser: mocks.updateUser } }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const { resetPassword } = await import("./actions");

const form = (password: string) => {
  const data = new FormData();
  data.set("password", password);
  return data;
};

beforeEach(() => vi.resetAllMocks());

describe("#116 reset password", () => {
  it.each([
    ["7", "x".repeat(7)],
    ["73", "x".repeat(73)],
  ])("refuses %s characters with the signup rule", async (_label, password) => {
    expect(await resetPassword({}, form(password))).toEqual({ error: PASSWORD_RULE });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("saves the new password and goes on signed in", async () => {
    mocks.updateUser.mockResolvedValue({ data: { user: {} }, error: null });
    await resetPassword({}, form("x".repeat(72)));
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "x".repeat(72) });
    expect(mocks.redirect).toHaveBeenCalledWith("/stations");
  });

  it("says the link expired when the reset session is gone", async () => {
    mocks.updateUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError", message: "Auth session missing!" },
    });
    expect(await resetPassword({}, form("correct horse"))).toEqual({
      error: "This reset link has expired. Ask for a new one.",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
