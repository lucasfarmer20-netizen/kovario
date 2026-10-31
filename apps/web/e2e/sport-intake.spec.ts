import { expect, test } from "@playwright/test";
import { LOCATION_CODE, ORG_SLUG, freshCustomer } from "./demo";
import { qr, scan } from "./scanner";
import {
  availableTag,
  createCustomer,
  payCashAtRegister,
  pickCustomer,
  statusPage,
} from "./stations";

// docs/02-DOMAIN-MODEL.md §4–§9, docs/06-STATIONS-UX.md: one sport intake through every
// floor station to pickup, scanning labels the way the floor does (scanner.ts).
test("sport intake: intake → wave → rollstock → reconcile → blast → locate → allocate → boxing → register → status", async ({
  page,
  browser,
}) => {
  const customer = freshCustomer("Sport");
  const tag = await availableTag(page);
  let intakeId = "";
  let number = "";

  await test.step("intake: new customer, one line, 2 totes, Save & Print Tote Tags", async () => {
    await page.goto("/intake");
    await createCustomer(page, customer);
    await page.getByLabel("Line 1 species").selectOption("whitefish_halibut");
    await page.getByLabel("Line 1 condition").selectOption("hg");
    await page.getByLabel("Line 1 method").selectOption("portions");
    await page.getByLabel("Line 1 lb").fill("20");
    await page.getByLabel("Totes").fill("2");
    await expect(page.getByRole("complementary", { name: "Price" })).toContainText("Total $");
    await page.getByRole("button", { name: "Save & Print Tote Tags" }).click();
    await page.waitForURL(/\/intake\/[0-9a-f-]{36}\?saved=/);
    const url = new URL(page.url());
    intakeId = url.pathname.split("/").pop()!;
    number = /INT-\d+/.exec(url.searchParams.get("saved") ?? "")?.[0] ?? "";
    expect(number).toMatch(/^INT-\d{4,}$/);
    // The saved intake carries its X-of-Y tote tags, QR text from the shared codec.
    await expect(page.getByText(qr.tote(number, 2), { exact: true })).toBeVisible();
  });

  await test.step("wave: add the intake, verify both totes by scan, complete", async () => {
    await page.goto("/wave");
    // Tap the order into the new wave; Start Verification creates the wave and starts it.
    const tile = page.getByRole("button", { name: number, exact: true });
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Start Verification" }).click();
    const complete = page.getByRole("button", { name: "Complete — Start Processing" });
    await expect(complete).toBeVisible();
    await expect(page.getByText("0 / 2 totes")).toBeVisible();
    await scan(page, qr.tote(number, 1));
    await expect(page.getByText("1 / 2 totes")).toBeVisible();
    await scan(page, qr.tote(number, 2));
    await expect(page.getByText("2 / 2 totes")).toBeVisible();
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(complete).toHaveCount(0);
  });

  await test.step("rollstock: scan a tote to open it, Finish queue → reconcile", async () => {
    await page.goto("/rollstock");
    const open = page.getByRole("region", { name: "Open at rollstock" });
    await scan(page, qr.tote(number, 1));
    await expect(open.getByRole("heading", { name: number })).toBeVisible();
    await open.getByRole("button", { name: "Finish queue" }).click();
    await expect(open.getByText("Scan a tote to open an order.")).toBeVisible();
  });

  await test.step(`reconcile: scan tote, scan tag ${tag}, weigh, Send to Blast Freezer`, async () => {
    await page.goto("/reconcile");
    await scan(page, qr.tote(number, 1));
    await expect(page.getByRole("heading", { name: `Order ${number}`, level: 2 })).toBeVisible();
    await scan(page, qr.tag(ORG_SLUG, tag));
    const vessel = page.getByRole("button", { name: new RegExp(`^Basket ${tag} · `) });
    await expect(vessel).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Enter weight manually" }).click();
    // 20 lb halibut H&G → portions expects 15 lb; 15.5 lb (+3.3%) is within the ±15% variance
    // hold (#87), so Send to Blast goes through.
    await page.getByLabel("Manual weight (lb)").fill("15.5");
    await page.getByRole("button", { name: "Save manual weight" }).click();
    await expect(vessel).toContainText("15.5 lb");
    await page.getByRole("button", { name: "Send to Blast Freezer" }).click();
    await expect(page.getByRole("heading", { name: "No order open" })).toBeVisible();
  });

  await test.step("blast: scan the basket tag in", async () => {
    await page.goto("/freezer/blast");
    await scan(page, qr.tag(ORG_SLUG, tag));
    await expect(
      page.getByRole("region", { name: "In blast" }).getByText(`Basket ${tag} · ${number}`),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Now in blast" })
        .getByText(`${number} is in the blast · variance +3.3% · within limit`),
    ).toBeVisible();
  });

  await test.step(`locate: scan tag, then location ${LOCATION_CODE}`, async () => {
    await page.goto("/freezer/locate");
    const step = page.getByRole("region", { name: "Locate step" });
    await scan(page, qr.tag(ORG_SLUG, tag));
    await expect(step.getByRole("heading", { name: `Basket ${tag}` })).toBeVisible();
    await expect(step).toContainText(number);
    await scan(page, qr.location(ORG_SLUG, LOCATION_CODE));
    await expect(step.getByRole("heading", { name: "No basket scanned" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "✓" })).toBeVisible();
  });

  await test.step("status page: the stored intake reads Ready for pickup", async () => {
    const status = await statusPage(browser, customer.digits);
    await expect(
      status.getByRole("heading", { name: `Order ${number} · Ready for pickup` }),
    ).toBeVisible();
    await status.context().close();
  });

  let sessionNumber = "";
  await test.step("allocation: pool the intake, one angler, one will-call box, Save & Price", async () => {
    await page.goto("/allocate/new");
    await pickCustomer(page, customer);
    await expect(page.getByRole("checkbox", { name: number })).toBeChecked();
    await page.getByRole("button", { name: "Start session" }).click();
    const editor = page.getByRole("region", { name: "Allocation session" });
    await expect(editor.getByLabel("Angler 1 name")).toHaveValue(customer.name);
    await editor.getByLabel("Species", { exact: true }).selectOption("whitefish_halibut");
    await editor.getByLabel("Method", { exact: true }).selectOption("portions");
    await editor.getByRole("textbox", { name: "Take-home lb" }).fill("17.5");
    await editor.getByRole("button", { name: "Add box" }).click();
    await expect(editor.getByLabel("Box method", { exact: true })).toHaveValue("willcall");
    await editor
      .getByLabel("Box size", { exact: true })
      .selectOption({ label: "25 lb box (≤25 lb, $6.00)" });
    await editor.getByLabel("Box weight lb", { exact: true }).fill("17.5");
    await editor.getByRole("button", { name: "Save & Price" }).click();
    await page.waitForURL(/\/allocate\/[0-9a-f-]{36}\?saved=/);
    sessionNumber = /ALC-\d+/.exec(new URL(page.url()).searchParams.get("saved") ?? "")?.[0] ?? "";
    expect(sessionNumber).toMatch(/^ALC-\d+$/);
    await expect(page.getByRole("table", { name: "Settlements" })).toContainText(customer.name);
  });

  await test.step("boxing: open the party, tick the box, scan the basket tag, Complete", async () => {
    await page.goto("/boxing");
    await page.getByRole("link", { name: new RegExp(`^${sessionNumber} · `) }).click();
    await page.waitForURL(/\/boxing\/[0-9a-f-]{36}$/);
    await page.getByRole("checkbox", { name: /will-call · 25 lb box · 17\.5 lb/ }).check();
    await scan(page, qr.tag(ORG_SLUG, tag));
    await expect(
      page.getByRole("checkbox", { name: `Tick Basket ${tag} (${number})` }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    const last = page.getByRole("list", { name: "Last Complete" });
    await expect(last).toContainText("picked up");
    await expect(last).toContainText(`Basket ${tag} (${number}) → emptied`);
    await expect(last).toContainText(`Closed: ${number}`);
  });

  await test.step("register: Load outstanding, record cash (manual provider)", async () => {
    await payCashAtRegister(page, customer);
  });

  await test.step("picked up: the status page drops the intake; the intake shows Picked up", async () => {
    const status = await statusPage(browser, customer.digits);
    await expect(status.getByText("No open orders found for this number.")).toBeVisible();
    await status.context().close();
    await page.goto(`/intake/${intakeId}`);
    await expect(page.locator(".intake-timeline")).toContainText("Picked up");
  });
});
