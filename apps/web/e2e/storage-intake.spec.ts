import { expect, test } from "@playwright/test";
import { freshCustomer } from "./demo";
import { createCustomer, payCashAtRegister } from "./stations";

// docs/02-DOMAIN-MODEL.md §5, docs/06-STATIONS-UX.md (Storage intake, Register): a cold-storage
// intake → a pickup batch for one of its boxes → paid at the register → that batch released.
test("storage intake: intake → pickup batch → register payment → release", async ({ page }) => {
  const customer = freshCustomer("Storage");
  let storageUrl = "";
  let batchNumber = "";

  await test.step("storage intake: customer, location, two boxes, Confirm", async () => {
    await page.goto("/storage");
    await createCustomer(page, customer);
    await page.getByLabel("Location").selectOption({ label: "IF-PALLET-01" });
    await page.getByLabel("Box 1 weight").fill("20");
    await page.getByLabel("Box 1 description").fill("Halibut fillets");
    await page.getByRole("button", { name: "Add box" }).click();
    await page.getByLabel("Box 2 weight").fill("15");
    await page.getByLabel("Box 2 description").fill("Lingcod");
    await page.getByRole("button", { name: "Confirm & Print 2 Labels" }).click();
    await page.waitForURL(/\/storage\/[0-9a-f-]{36}\?saved=/);
    storageUrl = new URL(page.url()).pathname;
    const header = page.getByRole("region", { name: "Storage intake header" });
    await expect(header).toContainText(/STG-\d+/);
    await expect(header).toContainText("Stored");
    await expect(header).toContainText("IF-PALLET-01");
  });

  await test.step("pickup batch: tick Box 1, quote, Create Pickup Batch", async () => {
    await page.getByRole("checkbox", { name: "Pick up Box 1" }).check();
    await expect(page.getByText(/1 box-days · Total \$1\.00/)).toBeVisible();
    await page.getByRole("button", { name: "Create Pickup Batch" }).click();
    const ready = page.getByText(/SPB-\d+ for \$1\.00 is ready to charge at the register/);
    await expect(ready).toBeVisible();
    batchNumber = /SPB-\d+/.exec(await ready.innerText())![0];
    const batches = page.getByRole("region", { name: "Pickup batches" });
    await expect(batches.getByRole("listitem").filter({ hasText: batchNumber })).toContainText(
      "Awaiting payment",
    );
  });

  await test.step("register: the batch loads as outstanding and is paid in cash", async () => {
    await payCashAtRegister(page, customer);
  });

  await test.step("release: the paid batch released Box 1; Box 2 stays stored", async () => {
    await page.goto(storageUrl);
    const batch = page
      .getByRole("region", { name: "Pickup batches" })
      .getByRole("listitem")
      .filter({ hasText: batchNumber });
    await expect(batch).toContainText("Released");
    await expect(batch).toContainText("Ref ");
    const boxes = page.getByRole("region", { name: "Boxes" });
    await expect(boxes.getByText("Box 1 · picked up")).toBeVisible();
    await expect(boxes.getByRole("checkbox", { name: "Pick up Box 2" })).toBeEnabled();
    const header = page.getByRole("region", { name: "Storage intake header" });
    await expect(header).toContainText("Partly picked up");
  });
});
