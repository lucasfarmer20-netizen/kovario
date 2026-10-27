import { afterEach, describe, expect, it, vi } from "vitest";
import * as buyRoute from "@/app/api/shipping/buy/route";
import * as rateCheckRoute from "@/app/api/shipping/rate-check/route";
import * as ratesRoute from "@/app/api/shipping/rates/route";
import * as verifyRoute from "@/app/api/shipping/verify/route";
import { POST as webhook } from "@/app/api/shipping/webhook/route";
import { webhookToken } from "shipping";
import { buyInput, shipmentInput, shippingRoute, type MakeDeps } from "./http";
import { ShippingRequestError, type ShippingDeps } from "./service";
import { orgWebhookUrl } from "./webhook-url";

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
  const SECRET = "test-platform-secret-not-real";
  const orgA = "a1900000-0000-4000-8000-00000000000a";
  const orgB = "b1900000-0000-4000-8000-00000000000b";
  const url = (org: string, token: string) =>
    `http://test/api/shipping/webhook?org=${org}&token=${token}`;
  const configure = () => {
    vi.stubEnv("SHIPPO_WEBHOOK_TOKEN", SECRET);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  };
  afterEach(() => vi.unstubAllEnvs());

  it("is off until configured", async () => {
    vi.stubEnv("SHIPPO_WEBHOOK_TOKEN", "");
    expect((await webhook(post({}, url(orgA, "x")))).status).toBe(503);
  });

  it("refuses a missing org, a missing or wrong token, and the platform secret itself", async () => {
    configure();
    const tokenA = await webhookToken(SECRET, orgA);
    expect((await webhook(post({}, "http://test/api/shipping/webhook"))).status).toBe(403);
    expect(
      (await webhook(post({}, `http://test/api/shipping/webhook?token=${tokenA}`))).status,
    ).toBe(403);
    expect((await webhook(post({}, url(orgA, "wrong")))).status).toBe(403);
    expect((await webhook(post({}, url(orgA, SECRET)))).status).toBe(403);
  });

  it("an org's token is no credential for another org", async () => {
    configure();
    const tokenA = await webhookToken(SECRET, orgA);
    expect((await webhook(post({}, url(orgB, tokenA)))).status).toBe(403);
  });

  it("the org's own token gets past authentication (then a malformed body is rejected)", async () => {
    configure();
    const tokenA = await webhookToken(SECRET, orgA);
    expect((await webhook(post("{", url(orgA, tokenA)))).status).toBe(400);
  });
});

describe("orgWebhookUrl (Admin → Sites)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("carries the org id and its derived token, never the platform secret", async () => {
    vi.stubEnv("SHIPPO_WEBHOOK_TOKEN", "test-platform-secret-not-real");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test/");
    const org = "a1900000-0000-4000-8000-00000000000a";
    const link = await orgWebhookUrl(org);
    expect(link).toBe(
      `https://app.example.test/api/shipping/webhook?org=${org}&token=${await webhookToken("test-platform-secret-not-real", org)}`,
    );
    expect(link).not.toContain("test-platform-secret-not-real");
  });

  it("is null when webhooks are not configured", async () => {
    vi.stubEnv("SHIPPO_WEBHOOK_TOKEN", "");
    expect(await orgWebhookUrl("a1900000-0000-4000-8000-00000000000a")).toBeNull();
  });
});
