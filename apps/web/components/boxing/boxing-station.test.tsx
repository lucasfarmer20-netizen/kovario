// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BoxingStation } from "./boxing-station";
import type { Wizard } from "./boxing-state";

const mocks = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/components/intake/use-station-session", () => ({
  useStationSession: () => ({ session: mocks.session, loaded: true }),
  managerElevation: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The shell's scanner is exercised in its own tests; here a plain input stands in for it.
vi.mock("@/src/components/station/station-shell", () => ({
  StationShell: ({
    onScan,
    status,
    children,
  }: {
    onScan: (raw: string) => void;
    status: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      {status}
      <input
        aria-label="Station scanner"
        onKeyDown={(e) => {
          if (e.key === "Enter") onScan(e.currentTarget.value);
        }}
      />
      {children}
    </main>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
  releaseErrors: string[] = [],
  wizard: Wizard = WIZARD,
) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "boxing_wizard") return { data: wizard, error: null };
    if (name === "release_party") {
      const message = releaseErrors.shift();
      return message ? { data: null, error: { message } } : { data: release, error: null };
    }
    return { data: null, error: null };
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
        Promise.resolve({ data: [], error: null }).then(resolve),
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
  expect(await screen.findByText(/BOX-0001 · will-call/)).toBeTruthy();
  expect(screen.getByText("Tag 042 (INT-0001)")).toBeTruthy();
  expect(screen.getByText("Exchange basket (INT-0001)")).toBeTruthy(); // P4: untagged, still listed
  expect(screen.getByText("DIRTY")).toBeTruthy();
  expect(screen.getByText("RIBBING")).toBeTruthy();
  expect(screen.getByText("Cut: skin on")).toBeTruthy();
});

it("WP15 Complete sends box ticks and tote ticks as independent facts (I1)", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByLabelText("Tick Tag 042 (INT-0001)"));
  fireEvent.change(screen.getByLabelText("Lbs left Tag 042 (INT-0001)"), {
    target: { value: "10" },
  });
  fireEvent.click(screen.getByText("Complete"));
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

it("WP15 I7 Complete with nothing ticked warns and never calls the server", async () => {
  const { rpc } = setup();
  fireEvent.click(await screen.findByText("Complete"));
  expect(await screen.findByText(/Nothing ticked/)).toBeTruthy();
  expect(rpc).not.toHaveBeenCalledWith("release_party", expect.anything());
});

it("WP15 P19 an unticked remainder blocks Complete (I5)", async () => {
  const { rpc } = setup();
  fireEvent.change(await screen.findByLabelText("Lbs left Tag 042 (INT-0001)"), {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByText("Complete"));
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
  fireEvent.click(screen.getByText("Complete"));
  expect(await screen.findByText(/Nothing left to release/)).toBeTruthy();
  expect(screen.getByText(/Already handled elsewhere \(dropped\): BOX-0001/)).toBeTruthy();
  expect(rpc.mock.calls.filter(([n]) => n === "boxing_wizard").length).toBe(2); // re-projected
});

it("WP15 scanning a tag ticks its tote; another party's boxing QR is refused (I11)", async () => {
  setup();
  const scanner = await screen.findByLabelText("Station scanner");
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "FL:TAG:rel-a:042" } });
  await waitFor(() =>
    expect((screen.getByLabelText("Tick Tag 042 (INT-0001)") as HTMLInputElement).checked).toBe(
      true,
    ),
  );
  fireEvent.keyDown(scanner, { key: "Enter", target: { value: "FL:BOX:othertoken" } });
  expect(await screen.findByText(/belongs to another party; one party per Complete/)).toBeTruthy();
});

const I8_NO_TOTE =
  "no fish has moved for ALC-0001 yet: tick the totes being handed over before finalising boxes, or ask a manager to override (I8)";
const I8_TOTE_LEFT =
  "no fish has moved for ALC-0001 yet: tick the totes being handed over before finalising boxes (I8)";

it("WP15 I8 refusal with no tote left offers a manager override that resends with the reason (DECISION-23)", async () => {
  const { rpc } = setup(undefined, "manager", [I8_NO_TOTE], { ...WIZARD, vessels: [] });
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByText("Complete"));
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
  fireEvent.click(screen.getByText("Complete"));
  expect(await screen.findByText(/still has baskets in the freezer/)).toBeTruthy();
  expect(screen.queryByText("Manager override")).toBeNull();
});

it("WP15 changing a tick hides a stale I8 override", async () => {
  setup(undefined, "manager", [I8_NO_TOTE], { ...WIZARD, vessels: [] });
  const box = await screen.findByLabelText(/BOX-0001/);
  fireEvent.click(box);
  fireEvent.click(screen.getByText("Complete"));
  expect(await screen.findByText("Manager override")).toBeTruthy();
  fireEvent.click(box);
  expect(screen.queryByText("Manager override")).toBeNull();
});

it("WP15 the I8 panel follows the server, not a stale pick list", async () => {
  // The wizard still lists a basket, but the server (under lock) found none left.
  const { rpc } = setup(undefined, "manager", [I8_NO_TOTE]);
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByText("Complete"));
  expect(await screen.findByText("Manager override")).toBeTruthy();
  expect(screen.queryByText(/still has baskets in the freezer/)).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2); // wizard + the refused Complete
});

it("WP15 an empty pick list never shows the override when the server found a tote", async () => {
  setup(undefined, "manager", [I8_TOTE_LEFT], { ...WIZARD, vessels: [] });
  fireEvent.click(await screen.findByLabelText(/BOX-0001/));
  fireEvent.click(screen.getByText("Complete"));
  expect(await screen.findByText(/still has baskets in the freezer/)).toBeTruthy();
  expect(screen.queryByText("Manager override")).toBeNull();
});
