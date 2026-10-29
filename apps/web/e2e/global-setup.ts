import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, type FullConfig } from "@playwright/test";
import { OWNER_EMAIL, STORAGE_STATE } from "./demo";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Demo tenant + a signed-in owner for the smoke flows:
 * 1. `pnpm db:seed-demo` (idempotent) fills demo-plant with rules, rates, tags, locations…;
 * 2. scripts/demo-owner.mjs creates / resets the e2e owner with a fresh random password that
 *    lives only in this process (never written, never logged);
 * 3. the owner signs in through /login and the session cookies become the tests' storage state.
 * Both scripts refuse to run against anything but a local Supabase.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  execSync("pnpm db:seed-demo", { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

  const password = randomBytes(18).toString("base64url");
  execSync("node scripts/demo-owner.mjs", {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, FILLETRY_DEMO_EMAIL: OWNER_EMAIL, FILLETRY_DEMO_PASSWORD: password },
  });

  const baseURL = config.projects[0]!.use.baseURL!;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    await page.goto("/login");
    await page.getByLabel("Email").fill(OWNER_EMAIL);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/stations", { timeout: 120_000 }); // next dev compiles on first hit
    await page.context().storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}
