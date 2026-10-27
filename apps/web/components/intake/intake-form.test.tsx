// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FilletryClient } from "db";
import { savePayload } from "rules";
import { IntakeForm } from "./intake-form";
import { emptyRow } from "./intake-form-state";
import type { StationSession } from "./use-station-session";

afterEach(cleanup);

const ref = (code: string, name: string, sort = 0) => ({ code, name, sort, is_active: true });
const TABLES: Record<string, unknown[]> = {
  species: [ref("salmon_silvers", "Silvers", 10), ref("whitefish_halibut", "Halibut", 20)],
  incoming_condition: [ref("whole", "Whole"), ref("filleted_ribs", "Filleted (ribs in)")],
  processing_method: [
    ref("fresh", "Fresh"),
    ref("smoking", "Smoking"),
    ref("portions", "Portions"),
  ],
};
const CONTEXT = {
  rate_card: { id: "card-1", name: "2026 rates" },
  rates: { fillets: 1.5, portions: 1.25, smoking: 2.75, ribbing_per_lb: 0.5, fast_pass_per_lb: 2 },
  lodge_cappable: { fillets: true, portions: true, smoking: true },
  customer: { id: "cust-1", is_lodge_guest: false, lodge_name: null, lodge_cap: null },
};

/** A stand-in for supabase-js: table reads resolve TABLES, RPCs resolve `rpcs`. */
function fakeClient(rpcs: Record<string, unknown>) {
  const rpc = vi.fn(async (name: string) => ({ data: rpcs[name] ?? null, error: null }));
  const from = (table: string) => {
    const result = { data: TABLES[table] ?? null, error: null };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: null, error: null }), // action_log: not yet completed
      then: (ok: (v: typeof result) => unknown, fail: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, fail),
    };
    return q;
  };
  return { client: { from, rpc } as unknown as FilletryClient, rpc };
}

function pick(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

it("matrix-filtered lines, live price panel, and Save sends the rules engine's payload", async () => {
  const saved = {
    intake_id: "int-1",
    number: "INT-0007",
    tote_jobs_queued: 2,
    receipt_job_id: null,
    printer_missing: false,
  };
  const { client, rpc } = fakeClient({ intake_price_context: CONTEXT, save_intake: saved });
  const session: StationSession = {
    client,
    claims: { userId: "u-1", orgId: "org-1", appRole: "staff", deviceId: null },
    siteName: "Dock",
  };
  const onSaved = vi.fn();
  render(
    <IntakeForm
      session={session}
      onSaved={onSaved}
      initial={{
        intakeId: "int-1",
        customer: {
          id: "cust-1",
          name: "Pat Plain",
          phone: "+19075550001",
          last_visit_at: null,
          is_lodge_guest: false,
          lodge_id: null,
          lodge_name: null,
        },
        rows: [emptyRow()],
        toteCount: 1,
        dirtyFish: false,
        dirtyNotes: "",
        cutNotes: "",
        processingNotes: "",
        fastPass: false,
      }}
    />,
  );
  await screen.findByLabelText("Line 1 species");
  await screen.findByText("2026 rates");

  // Salmon: the method list is the processing matrix's (fresh, smoking) for silvers/whole.
  pick("Line 1 species", "salmon_silvers");
  pick("Line 1 condition", "whole");
  const methods = within(screen.getByLabelText("Line 1 method") as HTMLElement)
    .getAllByRole("option")
    .map((o) => o.getAttribute("value"));
  expect(methods).toEqual(["", "fresh", "smoking"]);
  pick("Line 1 method", "fresh");
  pick("Line 1 lb", "50");
  pick("Line 1 fillets %", "60");

  // Halibut ribs-in: the matrix allows only portions, picked for the operator.
  fireEvent.click(screen.getByText("Add line"));
  pick("Line 2 species", "whitefish_halibut");
  pick("Line 2 condition", "filleted_ribs");
  expect((screen.getByLabelText("Line 2 method") as HTMLSelectElement).value).toBe("portions");
  pick("Line 2 lb", "30");

  const panel = screen.getByLabelText("Price");
  await waitFor(() => expect(within(panel).getByText("Total $122.50")).toBeTruthy());
  expect(within(panel).getByText("Ribbing — Halibut")).toBeTruthy();
  expect(within(panel).getByText("Line 1: 50 lb → est. 28 lb")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Totes"), { target: { value: "2" } });
  fireEvent.click(screen.getByText("Save & Print Tote Tags"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));

  const call = rpc.mock.calls.find(([name]) => name === "save_intake") as unknown as [
    string,
    { p_client_action_id: string; p_payload: unknown },
  ];
  expect(call[1].p_client_action_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(call[1].p_payload).toEqual(
    savePayload(
      { intakeId: "int-1", customerId: "cust-1", toteCount: 2, dirtyFish: false, fastPass: false },
      [
        {
          species: "salmon_silvers",
          condition: "whole",
          method: "fresh",
          lb: 50,
          filletsPct: 60,
          skinOff: false,
          notes: "",
        },
        {
          species: "whitefish_halibut",
          condition: "filleted_ribs",
          method: "portions",
          lb: 30,
          filletsPct: null,
          skinOff: false,
          notes: "",
        },
      ],
    ),
  );
});

it("Save is refused with the reasons when the form is incomplete", async () => {
  const { client, rpc } = fakeClient({ intake_price_context: CONTEXT });
  render(
    <IntakeForm
      session={{
        client,
        claims: { userId: "u", orgId: "o", appRole: "staff", deviceId: null },
        siteName: "",
      }}
      onSaved={vi.fn()}
      initial={{
        intakeId: "int-1",
        customer: {
          id: "c",
          name: "C",
          phone: null,
          last_visit_at: null,
          is_lodge_guest: false,
          lodge_id: null,
          lodge_name: null,
        },
        rows: [emptyRow()],
        toteCount: 1,
        dirtyFish: false,
        dirtyNotes: "",
        cutNotes: "",
        processingNotes: "",
        fastPass: false,
      }}
    />,
  );
  await screen.findByLabelText("Line 1 species");
  pick("Line 1 species", "salmon_silvers");
  fireEvent.click(screen.getByText("Save & Print Tote Tags"));
  expect((await screen.findByRole("alert")).textContent).toContain("Line 1: pick a condition.");
  expect(rpc.mock.calls.some(([name]) => name === "save_intake")).toBe(false);
});
