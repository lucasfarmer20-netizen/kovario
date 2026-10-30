import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// #116 forgot password, end to end on the local stack: request on /forgot-password → the
// reset email in Mailpit → its token_hash link through /auth/confirm → a new password on
// /reset-password → signed in; the old password stops working and the link works once.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const EMAIL = "e2e-reset@demo-plant.test";
const RESET_SENT = "If that email has an account, a reset link is on its way.";

type Status = { API_URL: string; MAILPIT_URL?: string; INBUCKET_URL?: string };
const status = (): Status => {
  const out = execSync("pnpm exec supabase status -o json", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.slice(out.indexOf("{"))) as Status;
};

type MailSummary = { ID: string };
async function mailpit(path: string, init?: RequestInit): Promise<Response> {
  const s = status();
  const base = s.MAILPIT_URL ?? s.INBUCKET_URL;
  if (!base) throw new Error("supabase status has no Mailpit URL");
  return fetch(`${base}${path}`, init);
}
const toQuery = `query=${encodeURIComponent(`to:"${EMAIL}"`)}`;

/** The /auth/confirm link of the newest email to EMAIL (polls Mailpit). */
async function resetLink(): Promise<URL> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await mailpit(`/api/v1/search?${toQuery}`);
        id = ((await res.json()) as { messages: MailSummary[] }).messages[0]?.ID;
        return id;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  const message = (await (await mailpit(`/api/v1/message/${id}`)).json()) as { HTML: string };
  const href = /href="([^"]*\/auth\/confirm\?[^"]*)"/.exec(message.HTML)?.[1];
  if (!href) throw new Error("reset email has no /auth/confirm link");
  return new URL(href.replaceAll("&amp;", "&"));
}

test.use({ storageState: { cookies: [], origins: [] } });

test("forgot password: request → email → link → new password → signed in", async ({
  page,
  browser,
  baseURL,
}) => {
  const oldPassword = randomBytes(18).toString("base64url");
  const newPassword = randomBytes(18).toString("base64url");
  // A demo-plant member with a known password (created or reset; local stack only).
  execSync("node scripts/demo-owner.mjs", {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, FILLETRY_DEMO_EMAIL: EMAIL, FILLETRY_DEMO_PASSWORD: oldPassword },
  });
  await mailpit(`/api/v1/search?${toQuery}`, { method: "DELETE" });

  await test.step("an unknown email gets the same answer as a real one", async () => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(`nobody-${randomBytes(4).toString("hex")}@plant.test`);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(RESET_SENT)).toBeVisible();
  });

  await test.step("/login → Forgot password? → request a reset link", async () => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await page.waitForURL("**/forgot-password");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(RESET_SENT)).toBeVisible();
  });

  let link = new URL("http://unset");
  await test.step("the email links to /auth/confirm with a recovery token_hash", async () => {
    link = await resetLink();
    expect(link.pathname).toBe("/auth/confirm");
    expect(link.searchParams.get("type")).toBe("recovery");
    expect(link.searchParams.get("token_hash")).toBeTruthy();
    expect(link.searchParams.get("next")).toBe("/reset-password");
  });

  // The template uses site_url (127.0.0.1:3000); the e2e server runs on its own port.
  const onTestServer = `${link.pathname}${link.search}`;
  await test.step("the link signs in and opens /reset-password; save a new password", async () => {
    await page.goto(onTestServer);
    await page.waitForURL("**/reset-password");
    await page.getByLabel("New password").fill(newPassword);
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await page.waitForURL("**/stations");
  });

  await test.step("the new password signs in, the old one doesn't, the link is spent", async () => {
    const fresh = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const other = await fresh.newPage();
    await other.goto(onTestServer);
    await other.waitForURL("**/login?notice=link");
    await expect(other.getByText("That link is invalid or has expired.")).toBeVisible();

    await other.getByLabel("Email").fill(EMAIL);
    await other.getByLabel("Password").fill(oldPassword);
    await other.getByRole("button", { name: "Sign in" }).click();
    await expect(other.getByText("Email or password is incorrect.")).toBeVisible();

    // A form action resets the fields, so fill both again.
    await other.getByLabel("Email").fill(EMAIL);
    await other.getByLabel("Password").fill(newPassword);
    await other.getByRole("button", { name: "Sign in" }).click();
    await other.waitForURL("**/stations");
    await fresh.close();
  });
});
