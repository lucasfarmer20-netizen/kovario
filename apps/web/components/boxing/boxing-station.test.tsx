// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ManualOptions } from "rules";
import { normalizeTagCode, parse } from "rules";
import { BoxingQueueStation, BoxingStation } from "./boxing-station";
import type { Wizard } from "./boxing-state";

const mocks = vi.hoisted(() => ({
  session: null as unknown,
  push: vi.fn(),
  headers: [] as string[],
  /** When set, a boxing_scan reply waits for it (deferred-RPC tests). */
  scanGate: null as null | ((raw: string) => Promise<void>),
  /** Rows of allocation_session_list (the boxing queue). */
  queue: [] as Record<string, unknown>[],
  /** boxing_wizard fails (a bad id, a network blip). */
  wizardFails: false,
}));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
  managerElevation: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
// The shell's scanner is exercised in its own tests; here a plain input stands in for it,
// beside the real "Enter manually" field (issues #84, #98).
vi.mock("@/src/components/station/station-shell", async () => {
  const { useState } = await import("react");
  const { ManualEntry } = await import("@/src/components/station/manual-entry");
  return {
    StationShell: function MockShell({
      onScan,
      manual,
      manualLabel,
      next,
      status,
      children,
    }: {
      onScan: (raw: string, parsed: unknown, method: "scan" | "manual") => void;
      manual?: ManualOptions;
      manualLabel?: string;
      next: string;
      status: ReactNode;
      children: ReactNode;
    }) {
      const [typing, setTyping] = useState(false);
      return (
        <main>
          <p data-testid="next-step">{next}</p>
          {status}
          <input
            aria-label="Station scanner"
            onKeyDown={(e) => {
              if (e.key === "Enter") onScan(e.currentTarget.value, null, "scan");
            }}
          />
          <ManualEntry
            open={typing}
            onOpenChange={setTyping}
            options={manual}
            label={manualLabel}
            onSubmit={(text, parsed) => onScan(text, parsed, "manual")}
          />
          {children}
        </main>
      );
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.headers.length = 0;
  mocks.scanGate = null;
  mocks.queue = [];
  mocks.wizardFails = false;
});

const WIZARD: Wizard = {
  session_id: "s1",
  number: "ALC-0001",
  state: "priced",
  party_name: "Pat Party",
  moved_before: false,
  finalized_count: 0,
  anglers: [{ settlement_id: "st1", number: "STL-0001", angler_name: "Ann", state: "draft" }],
  boxes: [
    {
      box_id: "b1",
      number: "BOX-0001",
      settlement_id: "st1",
      angler_name: "Ann",
      method: "willcall",
      size: "Medium",
      weight_lb: 20,
      shipment_number: null,
      ship_date: null,
    },
  ],
  vessels: [
    {
      vessel_id: "v1",
      intake_id: "i1",
      intake_number: "INT-0001",
      tag_code: "042",
      is_exchange: false,
      weight_lb: 30,
      species_summary: "Silvers",
      location_code: "IF-A-01-1-F",
      walk_seq: 1,
    },
    {
      vessel_id: "vx",
      intake_id: "i1",
      intake_number: "INT-0001",
      tag_code: null,
      is_exchange: true,
      weight_lb: 12,
      species_summary: null,
      location_code: null,
      walk_seq: 2,
    },
  ],
  intakes: [
    {
      intake_id: "i1",
      number: "INT-0001",
      state: "stored",
      customer_name: "Pat Party",
      dirty_fish: true,
      dirty_notes: "sandy",
      cut_notes: "skin on",
      processing_notes: null,
      ribbing: true,
      smoking: false,
      lines: [
        { species: "Silvers", method: "Fillets", method_code: "fillets", lb: 40, notes: null },
      ],
      other_sessions: [],
    },
  ],
};

/** Stand-in for public.boxing_scan (24_boxing_scan.test.sql pins the real one). */
function boxingScanReply(wizard: Wizard, args: Record<string, unknown>) {
  const raw = String(args.p_raw ?? "");
  const scanned = parse(raw);
  const reply = {
    ok: false,
    reason: "",
    kind: null,
    session_id: null,
    vessel_id: null,
    tag_code: null,
  };
  if (scanned.ok && scanned.value.kind === "BOX") {
    const session_id = scanned.value.token === "partytoken" ? "s1" : "other";
    if (!args.p_session_id) return { ...reply, ok: true, kind: "BOX", session_id };
    return session_id === args.p_session_id
      ? { ...reply, ok: true, kind: "BOX", session_id }
      : {
          ...reply,
          reason: `That receipt belongs to another party; one party per Complete. Finish ${wizard.number} first.`,
        };
  }
  if (!args.p_session_id) return { ...reply, reason: "Scan the boxing QR on a settlement receipt" };
  const code =
    scanned.ok && scanned.value.kind === "TAG" ? normalizeTagCode(scanned.value.code) : null;
  const vessel = wizard.vessels.find((v) => v.tag_code !== null && v.tag_code === code);
  return vessel
    ? { ...reply, ok: true, kind: "TAG", vessel_id: vessel.vessel_id, tag_code: code }
    : { ...reply, reason: `Basket ${code ?? raw} is not on ${wizard.number}'s pick list` };
}

function setup(
  release: unknown = {
    noop: false,
    finalized: [],
    moved: [],
    stale: [],
    shipping: [],
    closed_intakes: [],
  },
  appRole = "staff",
  releaseErrors: { message: string; hint?: string }[] = [],
  wizard: Wizard = WIZARD,
) {
  const respond = (name: string, args: Record<string, unknown> = {}) => {
    if (name === "boxing_wizard")
      return mocks.wizardFails
        ? { data: null, error: { message: "party not found" } }
        : { data: wizard, error: null };
    if (name === "release_party") {
      const error = releaseErrors.shift();
      return error ? { data: null, error } : { data: release, error: null };
    }
    if (name === "boxing_scan") return { data: boxingScanReply(wizard, args), error: null };
    return { data: null, error: null };
  };
  // A PostgREST builder: thenable, with setHeader (a typed code's entry-method header).
  const rpc = vi.fn((name: string, args?: Record<string, unknown>): unknown => {
    const builder = Object.assign(
      Promise.resolve().then(async () => {
        if (name === "boxing_scan" && mocks.scanGate) await mocks.scanGate(String(args?.p_raw));
        return respond(name, args);
      }),
      {
        setHeader: (header: string, value: string) => {
          mocks.headers.push(`${name} ${header}: ${value}`);
          return builder;
        },
      },
    );
    return builder;
  });
  const settlementSession = vi.fn(() => ({ data: { session_id: "other" }, error: null }));
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () =>
        table === "settlement" ? settlementSession() : { data: null, error: null },
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve({
          data: table === "allocation_session_list" ? mocks.queue : [],
          error: null,
        }).then(resolve),
    };
    return q;
  };
  mocks.session = {
    client: { rpc, from },
    claims: { orgId: "org", userId: "u", appRole },
    siteName: "Dock",
  };
  render(<BoxingStation sessionId="s1" />);
  return { rpc };
}

it("WP15 boxing shows planned boxes, the walk-order pick list and the notes panel", async () => {
  setup();
  expect(await screen.findByLabelText(/BOX-0001 · will-call/)).toBeTruthy();
  expect(screen.getByLabelText("Tick Basket 042 (INT-0001)")).toBeTruthy();
  expect(screen.getByLabelText("Tick Exchange basket (INT-0001)")).toBeTruthy(); // P4: untagged, still listed
  expect(screen.getByText("DIRTY")).toBeTruthy();
  expect(screen.getByText("RIBBING")).toBeTruthy();
  expect(screen.getByText("Cut: skin on")).toBeTruthy();
});

it("WP15 Complete sends box ticks and tote ticks as independent facts (I1)", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByLabelText("Tick Basket 042 (INT-0001)"));
  fireEvent.change(screen.getByLabelText("Lbs left Basket 042 (INT-0001)"), {
    target: { value: "10" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "release_party",
      expect.objectContaining({
        p_session_id: "s1",
        p_box_ticks: ["b1"],
        p_vessel_ticks: [{ vessel_id: "v1", lbs_left: 10, ticked: true, measure: 30 }],
      }),
    ),
  );
});

it("#86 an exchange basket (no tag to scan) is confirmed by tap and released on Complete", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  const tick = screen.getByLabelText("Tick Exchange basket (INT-0001)") as HTMLInputElement;
  fireEvent.click(tick);
  expect(tick.checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "release_party",
      expect.objectContaining({
        p_box_ticks: ["b1"],
        p_vessel_ticks: [{ vessel_id: "vx", lbs_left: null, ticked: true, measure: 12 }],
      }),
    ),
  );
});

it("WP15 I7 Complete with nothing ticked warns and never calls the server", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByText("Complete"));
  expect(await screen.findByText(/Nothing ticked/)).toBeTruthy();
  expect(rpc).not.toHaveBeenCalledWith("release_party", expect.anything());
});

it("WP15 P19 an unticked remainder blocks Complete (I5)", async () => {
  const { rpc } = setup();
  fireEvent.change(await screen.findByLabelText("Lbs left Basket 042 (INT-0001)"), {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText(/Lbs Left on an unticked line/)).toBeTruthy();
  expect(rpc).not.toHaveBeenCalledWith("release_party", expect.anything());
});

it("WP15 a server no-op keeps the form and shows its message (I7/D0)", async () => {
  const { rpc } = setup({
    noop: true,
    message: "Nothing left to release: everything ticked was already released or changed",
    finalized: [],
    moved: [],
    stale: [{ kind: "box", id: "b1", label: "BOX-0001", state: "picked_up" }],
    shipping: [],
    closed_intakes: [],
  });
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText(/Nothing left to release/)).toBeTruthy();
  expect(screen.getByText(/Already handled elsewhere \(dropped\): BOX-0001/)).toBeTruthy();
  expect(rpc.mock.calls.filter(([n]) => n === "boxing_wizard").length).toBe(2); // re-projected
});

it("WP15 scanning a tag ticks its tote; another party's boxing QR is refused (I11)", async () => {
  setup();
  const scanner = await screen.findByLabelText("Station scanner");
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "FL:TAG:rel-a:042" } });
  await waitFor(() =>
    expect((screen.getByLabelText("Tick Basket 042 (INT-0001)") as HTMLInputElement).checked).toBe(
      true,
    ),
  );
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "FL:BOX:othertoken" } });
  expect(await screen.findByText(/belongs to another party; one party per Complete/)).toBeTruthy();
});

it("#84 Enter manually: a typed tag ticks its tote; a tag off the pick list is refused", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Enter manually" }));
  const field = screen.getByLabelText("Basket number");
  fireEvent.change(field, { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Tick Basket 042 (INT-0001)") as HTMLInputElement).checked).toBe(
      true,
    ),
  );
  fireEvent.change(field, { target: { value: "0999" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  expect(await screen.findByText("Basket 999 is not on ALC-0001's pick list")).toBeTruthy();
  // Both went through the server scan path (validated, logged in scan_log), flagged manual.
  for (const raw of ["042", "999"])
    expect(rpc).toHaveBeenCalledWith(
      "boxing_scan",
      expect.objectContaining({ p_raw: raw, p_session_id: "s1" }),
    );
  expect(mocks.headers).toEqual([
    "boxing_scan x-filletry-entry-method: manual",
    "boxing_scan x-filletry-entry-method: manual",
  ]);
});

it("#84 a hardware scan is validated and logged by the same path, without the manual header", async () => {
  const { rpc } = setup();
  const scanner = await screen.findByLabelText("Station scanner");
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "FL:TAG:rel-a:042" } });
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "boxing_scan",
      expect.objectContaining({ p_raw: "FL:TAG:rel-a:042", p_session_id: "s1" }),
    ),
  );
  expect(mocks.headers).toEqual([]);
});

it("#84 boxing queue: a typed boxing QR opens its party through boxing_scan; a tag is refused", async () => {
  const { rpc } = setup();
  cleanup();
  render(<BoxingQueueStation />);
  fireEvent.click(await screen.findByRole("button", { name: "Enter manually" }));
  const field = screen.getByLabelText("Boxing code (on the receipt)");
  fireEvent.change(field, { target: { value: "fl:box:partytoken" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/boxing/s1"));
  expect(rpc).toHaveBeenCalledWith(
    "boxing_scan",
    expect.objectContaining({ p_raw: "FL:BOX:partytoken", p_session_id: undefined }),
  );
  fireEvent.change(field, { target: { value: "042" } });
  fireEvent.click(screen.getByRole("button", { name: "Enter" }));
  expect(await screen.findByText("Scan the boxing QR on a settlement receipt")).toBeTruthy();
  expect(mocks.headers).toHaveLength(2);
});

// The SQL HINT is the contract the screen branches on (15_release.test.sql pins both codes).
const I8_NO_TOTE = {
  message:
    "no fish has moved for ALC-0001 yet: tick the baskets being handed over before finalising boxes, or ask a manager to override (I8)",
  hint: "i8_override_available",
};
const I8_TOTE_LEFT = {
  message:
    "no fish has moved for ALC-0001 yet: tick the baskets being handed over before finalising boxes (I8)",
  hint: "i8_tote_left",
};

it("WP15 I8 refusal with no tote left offers a manager override that resends with the reason (DECISION-23)", async () => {
  const { rpc } = setup(undefined, "manager", [I8_NO_TOTE], { ...WIZARD, vessels: [] });
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText(/ask a manager to override/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Override reason"), {
    target: { value: "last basket left with ALC-0002" },
  });
  fireEvent.click(screen.getByText("Manager override"));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "release_party",
      expect.objectContaining({
        p_box_ticks: ["b1"],
        p_i8_override_reason: "last basket left with ALC-0002",
      }),
    ),
  );
  expect(await screen.findByText(/Released: 0 box\(es\)/)).toBeTruthy();
});

it("WP15 I8 refusal with totes left points at the pick list, never the override", async () => {
  setup(undefined, "manager", [I8_TOTE_LEFT]);
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText(/still has baskets in the freezer/)).toBeTruthy();
  expect(screen.queryByText("Manager override")).toBeNull();
});

it("WP15 changing a tick hides a stale I8 override", async () => {
  setup(undefined, "manager", [I8_NO_TOTE], { ...WIZARD, vessels: [] });
  const box = await screen.findByLabelText(/BOX-0001/);
  fireEvent.click(box);
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText("Manager override")).toBeTruthy();
  fireEvent.click(box);
  expect(screen.queryByText("Manager override")).toBeNull();
});

it("WP15 the I8 panel follows the server, not a stale pick list", async () => {
  // The wizard still lists a basket, but the server (under lock) found none left.
  const { rpc } = setup(undefined, "manager", [I8_NO_TOTE]);
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText("Manager override")).toBeTruthy();
  expect(screen.queryByText(/still has baskets in the freezer/)).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2); // wizard + the refused Complete
});

it("WP15 an empty pick list never shows the override when the server found a tote", async () => {
  setup(undefined, "manager", [I8_TOTE_LEFT], { ...WIZARD, vessels: [] });
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText(/still has baskets in the freezer/)).toBeTruthy();
  expect(screen.queryByText("Manager override")).toBeNull();
});

it("WP15 the I8 panel keys on the SQL hint, never on the English message", async () => {
  // Same wording as the no-tote refusal, but no hint: no override is offered.
  setup(undefined, "manager", [{ message: I8_NO_TOTE.message }], { ...WIZARD, vessels: [] });
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText(/ask a manager to override/)).toBeTruthy(); // the error is shown
  expect(screen.queryByText("Manager override")).toBeNull();
  expect(screen.queryByText(/still has baskets in the freezer/)).toBeNull();
});

it("WP15 a refused override (a tote reappeared) points at the freezer", async () => {
  setup(undefined, "manager", [
    I8_NO_TOTE,
    {
      message:
        "ALC-0001 still has a basket to tick (Basket 042 (INT-0001)); the I8 override applies only when none is left (DECISION-23)",
      hint: "i8_tote_left",
    },
  ]);
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  fireEvent.change(await screen.findByLabelText("Override reason"), {
    target: { value: "other party took it" },
  });
  fireEvent.click(screen.getByText("Manager override"));
  expect(await screen.findByText(/still has baskets in the freezer/)).toBeTruthy();
  expect(screen.queryByText("Manager override")).toBeNull();
});

it("WP15 a tote-left refusal re-projects so the stale pick list shows the tote", async () => {
  // The screen loaded an empty pick list (setup's first load); the server still sees a tote.
  const { rpc } = setup(undefined, "manager", [I8_TOTE_LEFT], { ...WIZARD, vessels: [] });
  await screen.findByLabelText(/BOX-0001/);
  rpc.mockImplementation(async (name: string) =>
    name === "boxing_wizard"
      ? { data: WIZARD, error: null } // the re-projection now lists the tote
      : { data: null, error: I8_TOTE_LEFT },
  );
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByLabelText("Tick Basket 042 (INT-0001)")).toBeTruthy(); // the tote now shows
  expect(screen.getByText(/still has baskets in the freezer/)).toBeTruthy(); // pointer kept
  expect((screen.getByLabelText(/BOX-0001/) as HTMLInputElement).checked).toBe(true); // I15
});

// Review on #90: a scan reply must apply to the form as it is when the reply lands.
const TWO_TAGS: Wizard = {
  ...WIZARD,
  vessels: [
    ...WIZARD.vessels,
    { ...WIZARD.vessels[0]!, vessel_id: "v2", tag_code: "043", walk_seq: 3 },
  ],
};

/** Holds each boxing_scan reply until the test releases it. */
function holdScans() {
  const held = new Map<string, () => void>();
  mocks.scanGate = (raw) => new Promise<void>((resolve) => held.set(raw, resolve));
  return {
    held,
    release: async (raw: string) => {
      await waitFor(() => expect(held.has(raw)).toBe(true));
      held.get(raw)!();
    },
  };
}
const ticked = (label: string) =>
  (screen.getByLabelText(`Tick ${label}`) as HTMLInputElement).checked;

it("#84 overlapping scans both tick, whatever order their replies land in; Complete waits", async () => {
  setup(undefined, "staff", [], TWO_TAGS);
  const scanner = await screen.findByLabelText("Station scanner");
  const scans = holdScans();
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "042" } });
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "043" } });
  await waitFor(() => expect(scans.held.size).toBe(2));
  const complete = screen.getByRole("button", { name: "Complete" }) as HTMLButtonElement;
  expect(complete.disabled).toBe(true); // never Complete over a scan still being checked
  await scans.release("043");
  await waitFor(() => expect(ticked("Basket 043 (INT-0001)")).toBe(true));
  await scans.release("042");
  await waitFor(() => expect(ticked("Basket 042 (INT-0001)")).toBe(true));
  expect(ticked("Basket 043 (INT-0001)")).toBe(true); // the first reply was not overwritten
  await waitFor(() => expect(complete.disabled).toBe(false));
});

it("#84 an Lbs-left edit made while a scan is validated survives the reply (no silent full pull)", async () => {
  setup(undefined, "staff", [], TWO_TAGS);
  const scanner = await screen.findByLabelText("Station scanner");
  fireEvent.click(screen.getByLabelText("Tick Basket 042 (INT-0001)"));
  const scans = holdScans();
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "043" } });
  await waitFor(() => expect(scans.held.size).toBe(1));
  const left = screen.getByLabelText("Lbs left Basket 042 (INT-0001)") as HTMLInputElement;
  fireEvent.change(left, { target: { value: "5" } });
  await scans.release("043");
  await waitFor(() => expect(ticked("Basket 043 (INT-0001)")).toBe(true));
  expect(left.value).toBe("5");
  expect(ticked("Basket 042 (INT-0001)")).toBe(true);
});

it("#84 a scan reply landing after Complete reset the form is dropped, not ticked", async () => {
  const { rpc } = setup(undefined, "staff", [], TWO_TAGS);
  const scanner = await screen.findByLabelText("Station scanner");
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByLabelText("Tick Basket 043 (INT-0001)"));
  const scans = holdScans();
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  // Scanned while Complete is running: validated, but it belongs to the old form.
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "042" } });
  expect(await screen.findByText(/Released:/)).toBeTruthy();
  await scans.release("042");
  expect(await screen.findByText("That scan arrived after Complete; scan it again.")).toBeTruthy();
  expect(ticked("Basket 042 (INT-0001)")).toBe(false);
  expect(rpc).toHaveBeenCalledWith("boxing_scan", expect.objectContaining({ p_raw: "042" }));
});

it("#98 the next step walks boxing: tick each box and basket → Complete", async () => {
  setup();
  await screen.findByLabelText("Tick Basket 042 (INT-0001)");
  const next = () => screen.getByTestId("next-step").textContent;
  expect(next()).toBe("Tick each box and basket");
  fireEvent.click(screen.getByLabelText("Tick Basket 042 (INT-0001)"));
  expect(next()).toBe("Complete");
});
it("#98 the boxing queue asks for the boxing QR or an order", async () => {
  setup();
  cleanup();
  render(<BoxingQueueStation />);
  expect(screen.getByTestId("next-step").textContent).toBe("Scan the boxing QR or tap an order");
});

const QUEUE_ROW = {
  session_id: "s2",
  number: "ALC-0002",
  party_name: "Lee Party",
  fulfillment_status: "pending",
  planned_count: 2,
  box_count: 2,
};

it("#130 Tick every box ticks each box in one tap; Complete sends them as box ticks only (I1)", async () => {
  const twoBoxes: Wizard = {
    ...WIZARD,
    boxes: [...WIZARD.boxes, { ...WIZARD.boxes[0]!, box_id: "b2", number: "BOX-0002" }],
  };
  const { rpc } = setup(undefined, "staff", [], twoBoxes);
  fireEvent.click(await screen.findByRole("button", { name: "Tick every box" }));
  expect((screen.getByLabelText(/BOX-0001/) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText(/BOX-0002/) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByRole("button", { name: "Tick every box" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      "release_party",
      expect.objectContaining({ p_box_ticks: ["b1", "b2"], p_vessel_ticks: [] }),
    ),
  );
});

it("#130 Complete waits with the reason until something is ticked (I7)", async () => {
  setup();
  const complete = (await screen.findByRole("button", { name: "Complete" })) as HTMLButtonElement;
  expect(complete.disabled).toBe(true);
  expect(screen.getByText(/^Nothing ticked yet/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/BOX-0001/));
  expect(complete.disabled).toBe(false);
});

it("#130 a party in the queue rail opens in one tap", async () => {
  mocks.queue = [QUEUE_ROW];
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "ALC-0002" }));
  expect(mocks.push).toHaveBeenCalledWith("/boxing/s2");
});

it("#130 the queue lists parties as tiles; a tap opens one", async () => {
  mocks.queue = [QUEUE_ROW];
  setup();
  cleanup();
  render(<BoxingQueueStation />);
  fireEvent.click(await screen.findByRole("button", { name: "ALC-0002" }));
  expect(mocks.push).toHaveBeenCalledWith("/boxing/s2");
  expect(screen.getByText("Lee Party · 2 of 2 boxes left")).toBeTruthy();
});

it("#130 once everything is handed over, the next receipt's boxing QR opens its party", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByLabelText("Tick Basket 042 (INT-0001)"));
  // Complete empties the party: the re-projection has nothing left.
  const respond = rpc.getMockImplementation()!;
  rpc.mockImplementation((name: string, args?: Record<string, unknown>) =>
    name === "boxing_wizard"
      ? Promise.resolve({ data: { ...WIZARD, boxes: [], vessels: [] }, error: null })
      : respond(name, args),
  );
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText("All handed over")).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Scan the boxing QR or tap an order");
  const scanner = screen.getByLabelText("Station scanner");
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "FL:BOX:othertoken" } });
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/boxing/other"));
  // Read as the queue reads it: no party scope, so it is not refused as another party (I11).
  expect(rpc).toHaveBeenCalledWith(
    "boxing_scan",
    expect.objectContaining({ p_raw: "FL:BOX:othertoken", p_session_id: undefined }),
  );
});

// Review on #137: a party emptied by another station still says what was handled elsewhere.
const EMPTIED: Wizard = { ...WIZARD, boxes: [], vessels: [] };

it("#130 I15 a rescan that empties the party keeps the stale-tick notices on screen", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByLabelText("Tick Basket 042 (INT-0001)"));
  // Another station finalised the box and freed the basket: the re-projection is empty.
  const respond = rpc.getMockImplementation()!;
  rpc.mockImplementation((name: string, args?: Record<string, unknown>) =>
    name === "boxing_wizard"
      ? Promise.resolve({ data: EMPTIED, error: null })
      : respond(name, args),
  );
  fireEvent.keyDown(screen.getByLabelText("Station scanner"), {
    key: "Enter",
    target: { value: "FL:BOX:partytoken" },
  });
  expect(await screen.findByText("Nothing left to hand over")).toBeTruthy();
  expect(screen.getByText(/BOX-0001 is no longer planned \(finalised elsewhere\)/)).toBeTruthy();
  expect(
    screen.getByText(/Basket 042 \(INT-0001\) is no longer in the freezer \(released elsewhere\)/),
  ).toBeTruthy();
});

it("#130 I7 a concurrent no-op that empties the party keeps its dropped lines on screen", async () => {
  const { rpc } = setup({
    noop: true,
    message: "Nothing left to release: everything ticked was already released or changed",
    finalized: [],
    moved: [],
    stale: [{ kind: "box", id: "b1", label: "BOX-0001", state: "picked_up" }],
    shipping: [],
    closed_intakes: [],
  });
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  const respond = rpc.getMockImplementation()!;
  rpc.mockImplementation((name: string, args?: Record<string, unknown>) =>
    name === "boxing_wizard"
      ? Promise.resolve({ data: EMPTIED, error: null })
      : respond(name, args),
  );
  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText("Nothing left to hand over")).toBeTruthy();
  expect(screen.getByText(/Already handled elsewhere \(dropped\): BOX-0001/)).toBeTruthy();
  expect(screen.getByText(/BOX-0001 is no longer planned/)).toBeTruthy();
});

// Review on #137 (CustomSeafoods): the not-found screen asks for a receipt, so it reads one.
it("#130 Party not found: scanning a receipt's boxing QR opens its party", async () => {
  mocks.wizardFails = true;
  const { rpc } = setup();
  expect(await screen.findByText("Party not found")).toBeTruthy();
  expect(screen.getByTestId("next-step").textContent).toBe("Scan the boxing QR or tap an order");
  fireEvent.keyDown(screen.getByLabelText("Station scanner"), {
    key: "Enter",
    target: { value: "FL:BOX:othertoken" },
  });
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/boxing/other"));
  expect(rpc).toHaveBeenCalledWith(
    "boxing_scan",
    expect.objectContaining({ p_raw: "FL:BOX:othertoken", p_session_id: undefined }),
  );
});

it("#130 Party not found: Enter manually asks for the boxing code, not a basket", async () => {
  mocks.wizardFails = true;
  setup();
  await screen.findByText("Party not found");
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  expect(screen.getByLabelText("Boxing code (on the receipt)")).toBeTruthy();
  expect(screen.queryByLabelText("Basket number")).toBeNull();
});

it("#130 Party not found: this party's own QR loads it again once it is reachable", async () => {
  mocks.wizardFails = true;
  setup();
  await screen.findByText("Party not found");
  mocks.wizardFails = false;
  fireEvent.keyDown(screen.getByLabelText("Station scanner"), {
    key: "Enter",
    target: { value: "FL:BOX:partytoken" },
  });
  expect(await screen.findByLabelText("Tick Basket 042 (INT-0001)")).toBeTruthy();
  expect(screen.getByText("ALC-0001 refreshed")).toBeTruthy();
  expect(screen.queryByText("Party not found.")).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});
