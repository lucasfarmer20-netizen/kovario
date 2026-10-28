import { expect, type Page } from "@playwright/test";
import { encode } from "rules";

/**
 * Keyboard-wedge scanner emulation. A floor scanner is a keyboard: it types the QR text into
 * whatever has focus and presses Enter. Stations keep their hidden `<ScanInput>` focused, so
 * this asserts focus first (a lost focus is a real station bug), then types like the hardware.
 */
export async function scan(page: Page, qr: string): Promise<void> {
  await expect(page.getByLabel("Station scanner")).toBeFocused();
  await page.keyboard.type(qr);
  await page.keyboard.press("Enter");
}

/** QR text for labels, from the one codec (packages/rules qr.ts, AGENTS.md hard rule 4). */
export const qr = {
  tote: (intakeNumber: string, toteNo: number) => encode("TOTE", { intakeNumber, toteNo }),
  tag: (orgSlug: string, code: string) => encode("TAG", { orgSlug, code }),
  location: (orgSlug: string, code: string) => encode("LOC", { orgSlug, code }),
};
