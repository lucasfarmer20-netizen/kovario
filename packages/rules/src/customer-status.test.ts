import { expect, it } from "vitest";
import { CUSTOMER_STAGES } from "./customer-status";
import { parseStatusPageUrl, statusPageUrl } from "./qr";

it("WP20 stage mapping table covers every intake state in plain language", () => {
  expect(CUSTOMER_STAGES).toEqual({
    draft: null,
    holding: "In cooler",
    processing: "Processing",
    rollstock: "Processing",
    reconcile: "Processing",
    blast_freezer: "Freezing",
    stored: "Ready for pickup",
    done: null,
    cancelled: null,
  });
});
it("WP20 receipt status URL round-trips without customer identifiers", () => {
  expect(statusPageUrl("demo-plant")).toBe("https://app.filletry.com/s/demo-plant");
  expect(parseStatusPageUrl(statusPageUrl("demo-plant"))).toBe("demo-plant");
  expect(parseStatusPageUrl("https://other.example/s/demo")).toBeNull();
  expect(parseStatusPageUrl("https://app.filletry.com/s/demo?phone=1234")).toBeNull();
  expect(() => statusPageUrl("../private")).toThrow(RangeError);
});
