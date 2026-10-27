import { expect, it } from "vitest";
import { ageBadge } from "./queue-list";
it("shows floor queue age in minutes and whole hours without negative ages", () => {
  const entered = "2026-10-26T00:00:00Z";
  const start = Date.parse(entered);
  expect(ageBadge(entered, start + 18 * 3600000)).toBe("18h");
  expect(ageBadge(entered, start + 5 * 60000)).toBe("5m");
  expect(ageBadge(entered, start - 60000)).toBe("0m");
});
