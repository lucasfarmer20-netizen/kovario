import { expect, test } from "@playwright/test";
import { freshCustomer } from "./demo";
import { qr, scan } from "./scanner";
import { createCustomer } from "./stations";

// docs/04-BUSINESS-RULES.md §6a (#87): Send to Blast over the ±15% variance limit is refused and
// the intake is held; a manager signs off with a reason and the send then goes through. The
// demo owner is a manager account, so the sign-off needs no PIN. Runs after the happy path and
// ends with the hold cleared, so it never blocks a later intake's send.
test("variance hold: an over-limit send is refused, a manager signs off, then it goes to blast", async ({
  page,
}) => {
  const customer = freshCustomer("Variance");
  let number = "";

  await test.step("intake: one line, 20 lb halibut H&G → portions (15 lb expected), 1 tote", async () => {
    await page.goto("/intake");
    await createCustomer(page, customer);
    await page.getByLabel("Line 1 species").selectOption("whitefish_halibut");
    await page.getByLabel("Line 1 condition").selectOption("hg");
    await page.getByLabel("Line 1 method").selectOption("portions");
    await page.getByLabel("Line 1 lb").fill("20");
    await page.getByLabel("Totes").fill("1");
    await page.getByRole("button", { name: "Save & Print Tote Tags" }).click();
    await page.waitForURL(/\/intake\/[0-9a-f-]{36}\?saved=/);
    number = /INT-\d+/.exec(new URL(page.url()).searchParams.get("saved") ?? "")?.[0] ?? "";
    expect(number).toMatch(/^INT-\d{4,}$/);
  });

  await test.step("rollstock: cooler bypass scan opens it, Finish queue → reconcile", async () => {
    await page.goto("/rollstock");
    const open = page.getByRole("region", { name: "Open at rollstock" });
    await scan(page, qr.tote(number, 1));
    await expect(open.getByRole("heading", { name: number })).toBeVisible();
    await open.getByRole("button", { name: "Finish queue" }).click();
    await expect(open.getByText("Scan a tote to open an order.")).toBeVisible();
  });

  await test.step("reconcile: 20 lb (+33.3%) → Send to Blast is refused and held", async () => {
    await page.goto("/reconcile");
    await scan(page, qr.tote(number, 1));
    await expect(page.getByRole("heading", { name: `Order ${number}`, level: 2 })).toBeVisible();
    await page.getByRole("button", { name: "Add exchange basket" }).click();
    const vessel = page.getByRole("button", { name: /^Exchange basket · / });
    await vessel.click();
    await page.getByRole("button", { name: "Enter weight manually" }).click();
    await page.getByLabel("Manual weight (lb)").fill("20");
    await page.getByRole("button", { name: "Save manual weight" }).click();
    await expect(vessel).toContainText("20 lb");
    await expect(page.getByText("over limit (limit ±15%)")).toBeVisible();
    await page.getByRole("button", { name: "Send to Blast Freezer" }).click();
    await expect(
      page.getByText(
        `Variance hold: ${number} is +33.3% (limit ±15%). Held with its rollstock neighbours until fixed or signed off`,
      ),
    ).toBeVisible();
    // Still open at reconcile, held, with its hold group listed.
    await expect(page.getByRole("heading", { name: `Order ${number}`, level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(`^${number} HELD$`) })).toBeVisible();
    const hold = page.getByRole("region", { name: "Variance hold" });
    await expect(hold).toContainText(`VARIANCE HOLD · ${number} +33.3% (limit ±15%)`);
    await expect(
      hold.getByText(`${number} · +33.3% · over limit · waiting at reconcile`),
    ).toBeVisible();
  });

  await test.step("sign-off: Other + a typed note (scanner paused); the send then goes to blast", async () => {
    const hold = page.getByRole("region", { name: "Variance hold" });
    await hold.getByRole("button", { name: "Other" }).click();
    await hold.getByRole("button", { name: "Add note (required)" }).click();
    const note = hold.getByLabel(/Sign-off note/);
    await expect(note).toBeFocused();
    // Real keystrokes into whatever has focus: they land in the note, not the scanner, and a
    // tap on the field (pointerup) keeps focus there.
    await page.keyboard.type("Short-weighted");
    await note.click(); // lands mid-text; End puts the caret back after it
    await page.keyboard.press("End");
    await page.keyboard.type(" at intake");
    await expect(note).toHaveValue("Short-weighted at intake");
    await expect(note).toBeFocused();
    await hold.getByRole("button", { name: "Done" }).click();
    await expect(page.getByLabel("Station scanner")).toBeFocused();
    await expect(hold).toContainText("Note: Short-weighted at intake");
    await hold.getByRole("button", { name: "Manager sign-off" }).click();
    await expect(page.getByText("Hold signed off")).toBeVisible();
    await expect(hold).toHaveCount(0);
    await page.getByRole("button", { name: "Send to Blast Freezer" }).click();
    await expect(page.getByRole("heading", { name: "No order open" })).toBeVisible();
  });

  await test.step("blast: the 'now in blast' line shows it over the limit", async () => {
    await page.goto("/freezer/blast");
    await expect(
      page
        .getByRole("region", { name: "Now in blast" })
        .getByText(`${number} is in the blast · variance +33.3% · over limit`),
    ).toBeVisible();
  });
});
