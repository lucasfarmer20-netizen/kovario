import { describe, expect, it } from "vitest";
import { defaultNext, emailLinkType, safeNextPath } from "./auth-redirect";

const origin = "https://app.filletry.test";

describe("safeNextPath", () => {
  it("keeps a same-origin path with its query and hash", () => {
    expect(safeNextPath("/reset-password", origin, "/x")).toBe("/reset-password");
    expect(safeNextPath("/admin/users?tab=2#top", origin, "/x")).toBe("/admin/users?tab=2#top");
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["absolute off-origin", "https://evil.test/steal"],
    ["absolute same-origin URL (paths only)", `${origin}/stations`],
    ["protocol-relative", "//evil.test"],
    ["backslash", "/\\evil.test"],
    ["tab hiding a //", "/\t/evil.test"],
    ["newline", "/\nevil"],
    ["javascript:", "javascript:alert(1)"],
    ["relative", "stations"],
  ])("refuses %s next", (_label, next) => {
    expect(safeNextPath(next, origin, "/fallback")).toBe("/fallback");
  });
});

describe("email link types", () => {
  it("accepts only the auth email types", () => {
    expect(emailLinkType("recovery")).toBe("recovery");
    expect(emailLinkType("signup")).toBe("signup");
    expect(emailLinkType("magiclink")).toBeNull();
    expect(emailLinkType("bogus")).toBeNull();
    expect(emailLinkType(null)).toBeNull();
  });

  it("lands each type on its own page when next is unusable", () => {
    expect(defaultNext("signup")).toBe("/onboarding");
    expect(defaultNext("recovery")).toBe("/reset-password");
    expect(defaultNext("invite")).toBe("/auth/accept");
    expect(defaultNext(null)).toBe("/stations");
  });
});
