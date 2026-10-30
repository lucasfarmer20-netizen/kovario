// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { meterPosition, VarianceMeter } from "./band";

afterEach(cleanup);

function zones(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".st-meter-zone")].map((z) => ({
    band: z.dataset.band,
    from: parseFloat(z.style.left),
    to: parseFloat(z.style.left) + parseFloat(z.style.width),
  }));
}

it("the meter runs the full range, −100% to +100%, labelled at both ends and at the limit", () => {
  const { container } = render(<VarianceMeter variancePct={3} limitPct={15} band="within" />);
  const scale = [...container.querySelectorAll(".st-meter-scale span")].map((s) => s.textContent);
  expect(scale).toEqual(["−100%", "−15%", "+15%", "+100%"]);
  expect(meterPosition(-100)).toBe(0);
  expect(meterPosition(0)).toBe(50);
  expect(meterPosition(100)).toBe(100);
});

it("at the default 15% limit the near band is 10–15% each side and over is beyond it", () => {
  const { container } = render(<VarianceMeter variancePct={12} limitPct={15} band="near" />);
  expect(zones(container)).toEqual([
    { band: "over", from: 0, to: meterPosition(-15) },
    { band: "near", from: meterPosition(-15), to: meterPosition(-10) },
    { band: "within", from: meterPosition(-10), to: meterPosition(10) },
    { band: "near", from: meterPosition(10), to: meterPosition(15) },
    { band: "over", from: meterPosition(15), to: 100 },
  ]);
});

it("a variance past ±100% pins the needle to the end and marks it", () => {
  const { container } = render(<VarianceMeter variancePct={140} limitPct={15} band="over" />);
  const needle = container.querySelector<HTMLElement>(".st-meter-needle")!;
  expect(needle.style.left).toBe("100%");
  expect(needle.dataset.clipped).toBe("true");
  const inRange = render(<VarianceMeter variancePct={-100} limitPct={15} band="over" />);
  expect(inRange.container.querySelector<HTMLElement>(".st-meter-needle")!.dataset.clipped).toBe(
    undefined,
  );
});

it("no estimate draws no needle", () => {
  const { container } = render(<VarianceMeter variancePct={null} limitPct={15} band="unknown" />);
  expect(container.querySelector(".st-meter-needle")).toBeNull();
});
