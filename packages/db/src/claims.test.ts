import { describe, expect, it } from "vitest";
import { isManager, filletryClaims } from "./claims";

describe("filletryClaims", () => {
  it("reads org, role and device claims", () => {
    expect(
      filletryClaims({
        sub: "u1",
        org_id: "o1",
        app_role: "station",
        device_id: "d1",
        role: "authenticated",
      }),
    ).toEqual({ userId: "u1", orgId: "o1", appRole: "station", deviceId: "d1" });
  });

  it("returns null without an org claim", () => {
    expect(filletryClaims({ sub: "u1", role: "authenticated" })).toBeNull();
  });

  it("rejects unknown roles", () => {
    expect(filletryClaims({ sub: "u1", org_id: "o1", app_role: "superuser" })).toBeNull();
  });

  it("treats owner and manager as managers", () => {
    expect(isManager(filletryClaims({ sub: "u", org_id: "o", app_role: "owner" }))).toBe(true);
    expect(isManager(filletryClaims({ sub: "u", org_id: "o", app_role: "manager" }))).toBe(true);
    expect(isManager(filletryClaims({ sub: "u", org_id: "o", app_role: "cashier" }))).toBe(false);
    expect(isManager(null)).toBe(false);
  });
});
