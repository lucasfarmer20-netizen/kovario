// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SuspectPicker, type SuspectBinRow, type SuspectRow } from "./suspect-picker";

afterEach(cleanup);

const row = (
  n: number,
  position: number,
  status: string,
  actual: number,
  expected = 50,
  extra: Partial<SuspectRow> = {},
): SuspectRow => {
  const pct = Math.round(((actual - expected) / expected) * 10000) / 100;
  const band = Math.abs(pct) > 15 ? "over" : Math.abs(pct) >= 10 ? "near" : "within";
  return {
    center_intake_id: "i2",
    hold_id: "h1",
    intake_id: `i${n}`,
    position,
    intake_number: `INT-000${n}`,
    state:
      status === "in_blast"
        ? "blast_freezer"
        : status === "upstream"
          ? "rollstock"
          : status === "stored"
            ? "stored"
            : "reconcile",
    status,
    waiting: status === "upstream" || status === "at_reconcile",
    expected_lb: expected,
    actual_lb: actual,
    variance_pct: pct,
    limit_pct: 15,
    band,
    species: ["salmon"],
    ...extra,
  };
};

const bins: SuspectBinRow[] = [
  { id: "v-big", intake_id: "i2", weight_lb: 64, is_exchange: true, asset_tag: null },
  { id: "v-tag", intake_id: "i2", weight_lb: 20, is_exchange: false, asset_tag: { code: "0042" } },
  { id: "v-3", intake_id: "i3", weight_lb: 30, is_exchange: true, asset_tag: null },
];

// INT-0002 flagged at 84 lb against 60 (+40%); INT-0003 is 20 lb short; INT-0001 already in blast.
const group = (fourth = "upstream") => [
  row(1, -1, "in_blast", 50),
  row(2, 0, "reconciled", 84, 60, { species: ["halibut", "salmon"] }),
  row(3, 1, "reconciled", 30),
  row(4, 2, fourth, fourth === "upstream" ? 0 : 50),
];

function Picker({
  rows,
  onMove = vi.fn(),
  onPullBack = vi.fn(),
}: {
  rows: SuspectRow[];
  onMove?: (vesselId: string, to: string, center: string) => void;
  onPullBack?: (intakeId: string, reason: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <SuspectPicker
      rows={rows}
      bins={bins}
      disabled={false}
      editingReason={editing}
      onEditReason={setEditing}
      onMove={onMove}
      onPullBack={onPullBack}
      onClose={() => undefined}
    />
  );
}

it("#88 the picker shows the hold group with variance, species, size and state", () => {
  render(<Picker rows={group()} />);
  const picker = screen.getByRole("region", { name: "Suspect picker" });
  expect(picker.textContent).toContain("SUSPECTS · INT-0002 +40% (limit ±15%) · HELD");
  expect(
    within(screen.getByRole("list", { name: "Flagged intake" })).getByRole("listitem").textContent,
  ).toBe("Flagged: INT-0002 · +40% · over limit · halibut, salmon · 60 lb · reconciled");
  // Most likely first: INT-0003 (−20 lb cancels +24 lb), then INT-0001 (0), then INT-0004 (waiting).
  expect(
    within(screen.getByRole("list", { name: "Suspects" }))
      .getAllByRole("listitem")
      .map((li) => li.firstChild?.textContent),
  ).toEqual([
    "INT-0003 · −40% · over limit · salmon · 50 lb · reconciled",
    "INT-0001 · 0% · within limit · salmon · 50 lb · in blast",
    "INT-0004 · −100% · over limit · salmon · 50 lb · not yet at reconcile",
  ]);
  expect(screen.getAllByRole("listitem")[1]!.className).toContain("station-band-over");
});

it("#88 no suggestions while any group intake is unreconciled; the waiting ones are named", () => {
  render(<Picker rows={group("upstream")} />);
  expect(
    screen.getByText(/Suggestions appear once every intake in the group is reconciled/).textContent,
  ).toBe(
    "Suggestions appear once every intake in the group is reconciled. Waiting on: INT-0004 (not yet at reconcile)",
  );
  expect(screen.queryByRole("list", { name: "Suggested moves" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Move this bin" })).toBeNull();
  cleanup();
  render(<Picker rows={group("at_reconcile")} />);
  expect(screen.getByText(/Waiting on: INT-0004 \(waiting at reconcile\)/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Move this bin" })).toBeNull();
});

it("#88 once every intake is reconciled the best move is suggested and moves the bin", () => {
  const onMove = vi.fn();
  render(<Picker rows={group("reconciled")} onMove={onMove} />);
  const moves = screen.getByRole("list", { name: "Suggested moves" });
  // +24 lb and −20 lb: tag 0042 (20 lb) leaves 4 lb off in total.
  expect(within(moves).getByRole("listitem").textContent).toContain(
    "Move 0042 · 20 lb INT-0002 → INT-0003 (off by 44 lb → 4 lb)",
  );
  fireEvent.click(within(moves).getByRole("button", { name: "Move this bin" }));
  expect(onMove).toHaveBeenCalledWith("v-tag", "i3", "i2");
});

it("#88 a suspect in blast is suggested with a pull back first", () => {
  const rows = group("reconciled");
  rows[2] = row(3, 1, "in_blast", 30, 50, { state: "blast_freezer" });
  render(<Picker rows={rows} />);
  const moves = screen.getByRole("list", { name: "Suggested moves" });
  fireEvent.click(within(moves).getByRole("button", { name: "Pull back INT-0003 first" }));
  expect(screen.getByRole("group", { name: "Pull back from blast" }).textContent).toContain(
    "Pull INT-0003 back from blast to reconcile",
  );
});

it("#88 pull back needs a reason, typed in an explicit editing mode", () => {
  const onPullBack = vi.fn();
  render(<Picker rows={group()} onPullBack={onPullBack} />);
  fireEvent.click(screen.getByRole("button", { name: "Pull back INT-0001" }));
  const confirm = screen.getByRole("button", { name: "Confirm pull back" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add reason" }));
  fireEvent.change(screen.getByLabelText(/Pull back reason/), {
    target: { value: "Fish from INT-0002" },
  });
  expect(confirm.disabled).toBe(true); // finish the reason first
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(confirm);
  expect(onPullBack).toHaveBeenCalledWith("i1", "Fish from INT-0002");
});

it("#88 a manager moves any bin between members at reconcile", () => {
  const onMove = vi.fn();
  render(<Picker rows={group()} onMove={onMove} />);
  expect(screen.queryByRole("button", { name: /to INT-0001/ })).toBeNull(); // in blast
  fireEvent.click(screen.getByRole("button", { name: "Exchange · 30 lb" }));
  fireEvent.click(screen.getByRole("button", { name: "Move Exchange · 30 lb to INT-0002" }));
  expect(onMove).toHaveBeenCalledWith("v-3", "i2", "i2");
});
