import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /healthz", () => {
  it("responds 200 with { ok: true }", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
