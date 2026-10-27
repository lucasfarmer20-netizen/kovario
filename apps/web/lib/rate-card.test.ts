import { describe, expect, it } from "vitest";
import { orderRateLines, ratesFromForm } from "./rate-card";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("client_action_id", "x");
  fd.set("rate_card_id", "y");
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("ratesFromForm (/admin/rate-cards, onboarding rates step)", () => {
  it("reads only rate:<key> fields, rounds to cents, blank = 0, accepts a $ sign", () => {
    expect(
      ratesFromForm(
        form({ "rate:fillets": "1.955", "rate:portions": "", "rate:fast_pass_per_lb": "$3.5" }),
      ),
    ).toEqual({
      lines: [
        { key: "fillets", amount: 1.96 },
        { key: "portions", amount: 0 },
        { key: "fast_pass_per_lb", amount: 3.5 },
      ],
    });
  });

  it("rejects negative or non-numeric amounts and an empty form", () => {
    expect(ratesFromForm(form({ "rate:fillets": "-1" }))).toHaveProperty("error");
    expect(ratesFromForm(form({ "rate:storage_per_box_day": "two" }))).toEqual({
      error: "Enter a dollar amount of at least 0 for storage per box day.",
    });
    expect(ratesFromForm(form({}))).toEqual({ error: "No rates to save." });
  });
});

describe("orderRateLines", () => {
  it("orders methods by their sort, then the named rates, and labels them", () => {
    const methods = [
      { code: "portions", name: "Portions", sort: 20 },
      { code: "fillets", name: "Fillets", sort: 30 },
    ];
    const lines = [
      { key: "storage_per_box_day", amount: 1 },
      { key: "fillets", amount: 2 },
      { key: "ribbing_per_lb", amount: 3 },
      { key: "portions", amount: 4 },
    ];
    expect(orderRateLines(lines, methods).map((l) => l.label)).toEqual([
      "Portions (per lb)",
      "Fillets (per lb)",
      "Ribbing (per lb)",
      "Cold storage (per box per day)",
    ]);
  });
});
