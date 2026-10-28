import { expect, test, type Browser, type Page } from "@playwright/test";
import { ORG_SLUG } from "./demo";

type Customer = { name: string; digits: string };

function customerSearch(page: Page) {
  return page.getByRole("combobox", { name: "Customer phone or name" });
}

/** Phone-first search → "new customer…" → name → Create (intake / storage desks). */
export async function createCustomer(page: Page, customer: Customer): Promise<void> {
  await customerSearch(page).fill(customer.digits);
  await page.getByRole("option", { name: /new customer/i }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(customer.name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(customer.name, { exact: true })).toBeVisible();
}

/** Phone-first search → pick the existing customer from the dropdown. */
export async function pickCustomer(page: Page, customer: Customer): Promise<void> {
  await customerSearch(page).fill(customer.digits);
  await page.getByRole("option", { name: new RegExp(customer.name) }).click();
}

/** A free asset tag code from /admin/asset-tags (available, not in use or retired). */
export async function availableTag(page: Page): Promise<string> {
  await page.goto("/admin/asset-tags");
  const free = page.locator("li", { hasText: "· available" }).first();
  await expect(free).toBeVisible();
  return (await free.locator("strong").innerText()).trim();
}

/** Register: the open cart for `customer` is paid in cash (manual provider). */
export async function payCashAtRegister(page: Page, customer: Customer): Promise<void> {
  await page.goto("/register");
  await pickCustomer(page, customer);
  const cart = page.getByRole("region", { name: "Customer and cart" });
  await expect(cart.getByRole("heading", { name: /^Cart / })).toBeVisible();
  await expect(cart.getByText("Nothing outstanding.")).toHaveCount(0);
  const payment = page.getByRole("region", { name: "Payment" });
  await payment.getByLabel("Tender").selectOption("cash");
  await expect(payment.getByLabel("Amount")).not.toHaveValue("");
  await payment.getByRole("button", { name: "Record Cash" }).click();
  await expect(cart.getByText("Due $0.00")).toBeVisible();
  await expect(payment.getByRole("link", { name: "Print receipt" })).toBeVisible();
}

/** The public status page, always as an anonymous visitor (no staff cookies). */
export async function statusPage(browser: Browser, digits: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto(`/s/${ORG_SLUG}`);
  await page.getByLabel("Phone number").fill(digits);
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(page.getByText(/Pickup hours:/)).toBeVisible();
  return page;
}
