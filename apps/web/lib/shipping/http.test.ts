import { afterEach, describe, expect, it, vi } from "vitest";
import * as buyRoute from "@/app/api/shipping/buy/route";
import * as rateCheckRoute from "@/app/api/shipping/rate-check/route";
import * as ratesRoute from "@/app/api/shipping/rates/route";
import * as verifyRoute from "@/app/api/shipping/verify/route";
import { POST as webhook } from "@/app/api/shipping/webhook/route";
import { buyInput, shipmentInput, shippingRoute, type MakeDeps } from "./http";
import { ShippingRequestError, type ShippingDeps } from "./service";

const post = (body: unknown, url = "http://test/api/shipping/x") =>
  new Request(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const deps: MakeDeps = async () => ({}) as ShippingDeps;
const id = "6f0f3c1e-1c55-4e55-9b55-0a1b2c3d4e5f";

describe("/api/shipping route plumbing", () => {
  it("every Shippo route runs on Node (never Edge) with room for retries", () => {
    for (const r of [verifyRoute, ratesRoute, buyRoute, rateCheckRoute]) {
      expect(r.runtime).toBe("nodejs");
      expect(r.maxDuration).toBe(60);
    }
  });

  it("rejects a non-JSON body and an invalid one", async () => {
    const route = shippingRoute(shipmentInput, async () => ({ ok: true }), deps);
    expect((await route(post("not json"))).status).toBe(400);
    const res = await route(post({ shipmentId: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request" });
  });

  it("a buy needs a client action id", async () => {
    const route = shippingRoute(buyInput, async () => ({ ok: true }), deps);
    expect((await route(post({ shipmentId: id }))).status).toBe(400);
    expect((await route(post({ shipmentId: id, clientActionId: "buy-12345678" }))).status).toBe(
      200,
    );
  });

  it("maps request errors to their status and code", async () => {
    const route = shippingRoute(
      shipmentInput,
      async () => {
        throw new ShippingRequestError("SHP-0001 already has its label", 409, "55000");
      },
      deps,
    );
    const res = await route(post({ shipmentId: id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "SHP-0001 already has its label", code: "55000" });
  });

  it("never echoes an unknown failure (it may carry provider or config detail)", async () => {
    const route = shippingRoute(
      shipmentInput,
      async () => {
        throw new Error("ShippoToken shippo_live_secret leaked");
      },
      deps,
    );
    const res = await route(post({ shipmentId: id }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("shippo_live");
  });
});

describe("/api/shipping/webhook", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off until configured", async () => {
    vi.stubEnv("SHIPPO_WEBHOOK_TOKEN", "");
    expect((await webhook(post({}, "http://test/api/shipping/webhook?token=x"))).status).toBe(503);
  });

  it("refuses a missing or wrong token before reading anything", async () => {
    vi.stubEnv("SHIPPO_WEBHOOK_TOKEN", "expected-token-value");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    expect((await webhook(post({}, "http://test/api/shipping/webhook"))).status).toBe(403);
    expect((await webhook(post({}, "http://test/api/shipping/webhook?token=wrong"))).status).toBe(
      403,
    );
  });

  it("rejects a malformed body with the right token", async () => {
    vi.stubEnv("SHIPPO_WEBHOOK_TOKEN", "expected-token-value");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    const res = await webhook(
      post("{", "http://test/api/shipping/webhook?token=expected-token-value"),
    );
    expect(res.status).toBe(400);
  });
});
