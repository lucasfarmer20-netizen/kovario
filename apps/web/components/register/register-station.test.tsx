// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FilletryClient } from "db";
import type { StationSession } from "@/components/intake/use-station-session";
import { Register } from "./register-station";
import type { Cart, CartPayment, PaymentResult } from "./register-state";

afterEach(cleanup);

const HIT = {
  id: "cust-1",
  name: "Pat Party",
  phone: "+19075551601",
  last_visit_at: null,
  is_lodge_guest: false,
  lodge_id: null,
  lodge_name: null,
};

const CART: Cart = {
  id: "o-1",
  number: "REG-0001",
  kind: "sale",
  state: "open",
  customer: { id: "cust-1", name: "Pat Party", phone: null },
  lines: [
    {
      id: "l-1",
      kind: "settlement",
      description: "STL-0001 — Pat (ALC-0001)",
      qty: 1,
      unit_price: 40,
      amount: 40,
      charge_id: null,
      settlement_id: "st-1",
      batch_id: null,
      retail_product_id: null,
    },
    {
      id: "l-2",
      kind: "storage",
      description: "Cold storage SPB-0001 (STG-0001, 1 box)",
      qty: 1,
      unit_price: 3,
      amount: 3,
      charge_id: "ch-2",
      settlement_id: null,
      batch_id: "b-1",
      retail_product_id: null,
    },
  ],
  totals: { subtotal: 43, tax: 2.58, total: 45.58, paid: 0, due: 45.58 },
  payments: [],
  blocking_payment_id: null,
  tax_setting: { mode: "exclusive", rate: 0.06, cap_amount: 30 },
  notices: [
    { level: "info", code: "requoted", message: "SPB-0000 re-quoted as SPB-0001: 2.00 → 3.00" },
  ],
};

const pay = (over: Partial<CartPayment>): CartPayment => ({
  id: "p-1",
  number: "PAY-0001",
  state: "approved",
  provider: "dejavoo_spin",
  amount: 45.58,
  requested_amount: 45.58,
  tender: "card",
  tender_ref: null,
  attempt: 1,
  card_brand: "VISA",
  card_last4: "4242",
  entry_mode: "chip",
  auth_code: "A1",
  decline_reason: null,
  message: null,
  reversed_amount: null,
  ...over,
});

/** supabase-js stand-in: table reads, RPCs, and a session token for the payments API. */
function fakeClient(rpcs: Record<string, unknown>) {
  const tables: Record<string, unknown[]> = {
    payment_terminal: [{ id: "t-1", name: "Dejavoo 1", provider: "dejavoo_spin" }],
    retail_product: [{ id: "rp-1", name: "Ice pack", unit_price: 2.5 }],
  };
  const rpc = vi.fn(async (name: string) => ({ data: rpcs[name] ?? null, error: null }));
  const from = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      neq: () => q,
      order: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: typeof result) => unknown, fail: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, fail),
    };
    return q;
  };
  const auth = { getSession: async () => ({ data: { session: { access_token: "tok-123" } } }) };
  // the `elevate` Edge Function: a manager PIN mints an elevation token
  const functions = { invoke: async () => ({ data: { ok: true, token: "elev-1" }, error: null }) };
  return { client: { from, rpc, auth, functions } as unknown as FilletryClient, rpc };
}

const session = (client: FilletryClient): StationSession => ({
  client,
  claims: { userId: "u-1", orgId: "org-1", appRole: "cashier", deviceId: null },
  siteName: "Counter",
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const answer = (body: PaymentResult | { error: string }, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );

async function loadCart(rpcs: Record<string, unknown> = {}) {
  const fake = fakeClient({
    search_customers: [HIT],
    register_load_outstanding: CART,
    register_order: CART,
    ...rpcs,
  });
  render(<Register session={session(fake.client)} />);
  fireEvent.change(screen.getByLabelText("Customer phone or name"), { target: { value: "907" } });
  fireEvent.click(await screen.findByText("Pat Party"));
  await screen.findByText("STL-0001 — Pat (ALC-0001)");
  await screen.findByRole("option", { name: "Dejavoo 1" });
  return fake;
}

const sentBody = (call = 0) =>
  JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;

it("Load outstanding fills the cart from the server: settlement + storage lines, tax, notices", async () => {
  const { rpc } = await loadCart();
  expect(rpc).toHaveBeenCalledWith("register_load_outstanding", {
    p_client_action_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    p_customer_id: "cust-1",
    p_order_id: undefined,
  });
  expect(screen.getByText("Cold storage SPB-0001 (STG-0001, 1 box)")).toBeTruthy();
  expect(screen.getByText("Tax (6% exclusive, max $30.00)")).toBeTruthy();
  expect(screen.getByText("Due $45.58")).toBeTruthy();
  expect(screen.getByText(/re-quoted as SPB-0001/)).toBeTruthy();
  expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("45.58");
});

it("Charge (card) → approved, paid in full → receipt link; the request carries the caller's token", async () => {
  await loadCart();
  fetchMock.mockReturnValueOnce(
    answer({
      status: "applied",
      payment: pay({}),
      order: { ...CART, state: "paid", payments: [pay({})] },
    }),
  );
  fireEvent.click(screen.getByText("Charge"));
  await screen.findByText(/PAY-0001 approved — \$45.58. Paid in full./);
  const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
  expect(url).toBe("/api/payments/sale");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  expect(sentBody()).toMatchObject({
    orderId: "o-1",
    amount: 45.58,
    tender: "card",
    terminalId: "t-1",
  });
  expect(screen.getByText("Print receipt").getAttribute("href")).toBe("/register/receipt/p-1");
});

it("partial approval → the remainder is due on another payment", async () => {
  await loadCart();
  const partial = pay({ amount: 20, requested_amount: 45.58 });
  fetchMock.mockReturnValueOnce(
    answer({
      status: "applied:partial",
      payment: partial,
      order: { ...CART, payments: [partial], totals: { ...CART.totals, paid: 20, due: 25.58 } },
    }),
  );
  fireEvent.click(screen.getByText("Charge"));
  await screen.findByText(
    /Partial approval: \$20.00 of \$45.58 captured. Collect the remaining \$25.58/,
  );
  expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("25.58");
});

it("declined → the bank's reason; Charge stays available for a retry", async () => {
  await loadCart();
  const declined = pay({ state: "declined", decline_reason: "Insufficient funds" });
  fetchMock.mockReturnValueOnce(
    answer({ status: "applied", payment: declined, order: { ...CART, payments: [declined] } }),
  );
  fireEvent.click(screen.getByText("Charge"));
  await screen.findByText(/Declined: Insufficient funds/);
  expect(screen.getByText("Charge")).toBeTruthy();
});

it("error → could not reach the terminal; an API error is shown, not swallowed", async () => {
  await loadCart();
  fetchMock.mockReturnValueOnce(
    answer({ error: "PAY-0001 is still pending: check its status before charging again" }, 409),
  );
  fireEvent.click(screen.getByText("Charge"));
  await screen.findByText(/still pending: check its status/);
});

it("present card → Cancel: the UI unblocks at once and the terminal is told to abort", async () => {
  const pendingCart = { ...CART, payments: [pay({ state: "pending" })] };
  await loadCart({ register_order: pendingCart });
  fetchMock.mockImplementationOnce(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      ),
  );
  fetchMock.mockReturnValueOnce(
    answer({ status: "abort_sent", payment: pay({ state: "pending" }), order: pendingCart }),
  );
  fireEvent.click(screen.getByText("Charge"));
  await screen.findByText("Present card on the terminal.");
  expect(screen.queryByText("Charge")).toBeNull();
  fireEvent.click(screen.getByText("Cancel"));
  await screen.findByText(/Cancel sent/);
  expect(fetchMock.mock.calls[1]![0]).toBe("/api/payments/abort");
  expect(sentBody(1)).toEqual({ paymentId: "p-1" });
  // the sale may still be running on the terminal: no manager mark yet, only Check status
  expect(screen.queryByText("Manager: mark…")).toBeNull();
  expect(screen.getByText(/May still be running on the terminal/)).toBeTruthy();
  expect(screen.getByText("Check status")).toBeTruthy();
});

it("indeterminate blocks Charge until Check status resolves it", async () => {
  await loadCart();
  const unknown = pay({ state: "indeterminate" });
  const blocked = { ...CART, payments: [unknown], blocking_payment_id: "p-1" };
  fetchMock.mockReturnValueOnce(answer({ status: "applied", payment: unknown, order: blocked }));
  fireEvent.click(screen.getByText("Charge"));
  await screen.findByText(/did not confirm PAY-0001/);
  expect(screen.getByText(/PAY-0001 is still indeterminate — check its status first/)).toBeTruthy();
  expect(screen.queryByText("Charge")).toBeNull();

  fetchMock.mockReturnValueOnce(
    answer({
      status: "applied",
      payment: pay({}),
      order: { ...CART, state: "paid", payments: [pay({})] },
    }),
  );
  fireEvent.click(screen.getByText("Check status"));
  await screen.findByText(/Paid in full/);
  expect(fetchMock.mock.calls[1]![0]).toBe("/api/payments/status");
});

it("cash records through the manual tender without a terminal", async () => {
  await loadCart();
  fireEvent.change(screen.getByLabelText("Tender"), { target: { value: "cash" } });
  const cash = pay({ tender: "cash", provider: "manual", card_last4: null });
  fetchMock.mockReturnValueOnce(
    answer({
      status: "applied",
      payment: cash,
      order: { ...CART, state: "paid", payments: [cash] },
    }),
  );
  fireEvent.click(screen.getByText("Record Cash"));
  await waitFor(() => expect(sentBody()).toMatchObject({ tender: "cash", terminalId: null }));
  await screen.findByText(/Paid in full/);
});

it("a successful PARTIAL refund reads as success — the payment stays approved for the rest", async () => {
  const approved = pay({
    state: "approved",
    amount: 45.58,
    refundable: 45.58,
    reversed_amount: null,
  });
  await loadCart({
    register_load_outstanding: { ...CART, payments: [approved] },
    register_order: { ...CART, payments: [approved] },
  });
  fireEvent.click(screen.getByText("Refund"));
  const panel = within(screen.getByLabelText("Manager action"));
  expect(panel.getByDisplayValue("45.58")).toBeTruthy(); // defaults to what is still refundable
  fireEvent.change(panel.getByDisplayValue("45.58"), { target: { value: "10" } });
  fireEvent.change(panel.getByLabelText("Reason"), { target: { value: "one bag short" } });
  fireEvent.click(screen.getByText("Manager PIN…"));
  fireEvent.change(screen.getByLabelText("Manager PIN PIN"), { target: { value: "1234" } });
  fetchMock.mockReturnValueOnce(
    answer({
      status: "refunded",
      payment: pay({ state: "approved", reversed_amount: 10, refundable: 35.58 }),
      order: null,
      refund_order: { refund_amount: 10 },
    } as unknown as PaymentResult),
  );
  fireEvent.click(screen.getByText("Continue"));
  await screen.findByText(
    "PAY-0001: $10.00 returned (refunded). $35.58 is still captured. Nothing is released by a refund.",
  );
  expect(screen.queryByText(/did not refund/)).toBeNull();
  expect(fetchMock.mock.calls[0]![0]).toBe("/api/payments/refund");
  expect(sentBody()).toMatchObject({
    amount: 10,
    reason: "one bag short",
    elevationToken: "elev-1",
  });
});
