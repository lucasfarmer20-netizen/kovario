// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FeedbackBanner } from "./scan-feedback";

afterEach(cleanup);

it("scan feedback text keeps its ✓ / ✕ glyph beside the icon (e2e and screen readers read it)", () => {
  render(<FeedbackBanner tone="ok" text="Basket 042 added to INT-0002" event={1} />);
  expect(screen.getByRole("status").textContent).toBe("✓ Basket 042 added to INT-0002");
  cleanup();
  render(<FeedbackBanner tone="rejected" text="Scan a different basket." event={2} />);
  expect(screen.getByRole("status").textContent).toBe("✕ Scan a different basket.");
  cleanup();
  render(<FeedbackBanner tone="idle" text="Scanner ready" />);
  expect(screen.getByRole("status").textContent).toBe("Scanner ready");
});
