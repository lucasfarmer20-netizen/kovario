import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/demo";

// WP-23 e2e smoke: drives the demo tenant `demo-plant` on the local Supabase stack
// (`supabase start && supabase db reset`, then `node scripts/web-env.mjs`). CI serves the
// production build (`next start`); locally `next dev` is started unless one is running.
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;
const ci = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One plant, one floor: the flows share stations (wave, rollstock, freezers), so run serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: ci ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
    baseURL,
    storageState: STORAGE_STATE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: ci ? `pnpm exec next start -p ${port}` : `pnpm exec next dev -p ${port}`,
    url: `${baseURL}/healthz`,
    reuseExistingServer: !ci,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
