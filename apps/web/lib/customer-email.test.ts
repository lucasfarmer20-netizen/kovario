import { expect, it, vi } from "vitest";
import {
  customerEmail,
  deliverCustomerEmail,
  dispatchAuthorized,
  scrubEmailError,
} from "../../../supabase/functions/_shared/customer-email";

it.each(["intake_confirmation", "ready_for_pickup", "shipped"] as const)(
  "WP20 %s template carries org branding, hours, notice and status link",
  (kind) => {
    const message = customerEmail({
      kind,
      orgName: "Plant <A>",
      slug: "plant-a",
      reference: "INT-0001",
      pickupHours: "9–5",
      notice: "Final charges apply",
      tracking: "TRACK-123",
    });
    expect(message.subject).toContain("Plant <A>");
    expect(message.html).toContain("Plant &lt;A&gt;");
    expect(message.text).toContain("Final charges apply");
    expect(message.text).toContain("https://app.filletry.com/s/plant-a");
    expect(message.text).toContain(kind === "shipped" ? "TRACK-123" : "9–5");
  },
);
it("WP20 Resend errors retain only HTTP status", () => {
  expect(scrubEmailError(429)).toBe("resend_http_429");
});

it("WP20 dispatcher authentication accepts only the configured bearer credential", async () => {
  const token = crypto.randomUUID();
  expect(await dispatchAuthorized(`Bearer ${token}`, token)).toBe(true);
  expect(await dispatchAuthorized(`Bearer ${crypto.randomUUID()}`, token)).toBe(false);
  expect(await dispatchAuthorized(token, token)).toBe(false);
  expect(await dispatchAuthorized(null, token)).toBe(false);
  expect(await dispatchAuthorized(`Bearer ${token}`, undefined)).toBe(false);
});

it("WP20 Resend retries exact body with a stable idempotency key and scrubs failures", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("private provider details", { status: 429 }))
    .mockResolvedValueOnce(new Response("{}", { status: 200 }));
  const payload = {
    from: "Plant <mail@example.test>",
    to: ["customer@example.test"],
    subject: "Ready",
    text: "Ready",
  };
  expect(await deliverCustomerEmail(payload, "", "outbox-id", request)).toBe("resend_http_429");
  expect(await deliverCustomerEmail(payload, "", "outbox-id", request)).toBeNull();
  const first = request.mock.calls[0]![1]!;
  const second = request.mock.calls[1]![1]!;
  expect(first.body).toBe(second.body);
  expect(new Headers(first.headers).get("Idempotency-Key")).toBe("customer-email/outbox-id");
  request.mockRejectedValueOnce(new Error("private transport details"));
  expect(await deliverCustomerEmail(payload, "", "outbox-id", request)).toBe(
    "email_transport_failed",
  );
});
