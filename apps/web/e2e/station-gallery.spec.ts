import { expect, test } from "@playwright/test";
import { GALLERY_STATE_IDS } from "../app/dev/station-gallery/state-ids";
import { WAVE_STATE_IDS } from "../app/dev/station-gallery/wave-state-ids";

// docs/12-DESIGN-SYSTEM.md (#125): every station state fits a phone (400 px) and a landscape
// tablet (1280 × 800) without horizontal scrolling, and every tap target is at least 56 px
// (AGENTS rule 6). The gallery renders each state from static props, so no data is needed.
const TOUCH = 56;
const VIEWPORTS = [
  { name: "phone", width: 400, height: 860 },
  { name: "tablet", width: 1280, height: 800 },
];
const PAGES = [
  "",
  ...GALLERY_STATE_IDS.map((id) => `/${id}`),
  ...WAVE_STATE_IDS.map((id) => `/wave/${id}`),
];

for (const viewport of VIEWPORTS) {
  test(`station gallery at ${viewport.name} (${viewport.width} px): no sideways scroll, targets ≥ ${TOUCH} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const path of PAGES) {
      await test.step(path || "index", async () => {
        await page.goto(`/dev/station-gallery${path}`);
        await expect(page.locator(".station").first()).toBeVisible();
        const { scrollWidth, clientWidth, small } = await page.evaluate((touch) => {
          const targets = document.querySelectorAll<HTMLElement>(
            ".station :is(button, a[href], input, select, textarea, [role=button])",
          );
          const small = [...targets]
            // The scanner input is hidden on purpose (one focused ScanInput, wet-glove rule).
            .filter((el) => !el.classList.contains("station-scan-input"))
            .filter(
              (el) =>
                !el.closest("[aria-hidden=true]") && (el as HTMLInputElement).type !== "hidden",
            )
            .map((el) => ({ el, box: el.getBoundingClientRect() }))
            .filter(({ box }) => box.width > 0 && box.height > 0)
            .filter(({ box }) => box.height < touch - 0.5 || box.width < touch - 0.5)
            .map(({ el, box }) => {
              const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
              return `${el.tagName.toLowerCase()} "${name.slice(0, 40)}" ${Math.round(box.width)}×${Math.round(box.height)}`;
            });
          const root = document.documentElement;
          return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, small };
        }, TOUCH);
        expect(scrollWidth, "no horizontal scrolling").toBeLessThanOrEqual(clientWidth);
        expect(small, `tap targets under ${TOUCH} px`).toEqual([]);
      });
    }
  });
}
