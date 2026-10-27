"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatPhone } from "rules";
import { CustomerSearch } from "@/components/customers/customer-search";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import { searchCustomers } from "@/components/intake/intake-data";
import {
  managerElevation,
  useStationSession,
  type StationSession,
} from "@/components/intake/use-station-session";
import { ManagerPinOverlay } from "@/src/components/station/pin-overlay";
import {
  addRetail,
  listCardTerminals,
  listRetailProducts,
  loadOutstanding,
  postPayments,
  readCart,
  removeLine,
  resolvePayment,
  resolveReversal,
  voidCart,
  type RetailProduct,
  type Terminal,
} from "./register-data";
import {
  LINE_KIND_LABELS,
  TENDER_LABELS,
  cartLocked,
  chargeBlocker,
  chargeInputError,
  chargeView,
  money,
  markable,
  paymentLabel,
  reversalUnresolved,
  reversalView,
  reversible,
  unresolved,
  type Cart,
  type CartPayment,
  type ChargeView,
  type Notice,
  type ReversalResult,
  type TenderType,
} from "./register-state";

function Shell({ session, children }: { session: StationSession | null; children: ReactNode }) {
  return (
    <main className="station intake-station register-station">
      <header>
        <div>
          <p className="station-eyebrow">Filletry · {session?.siteName ?? "Register"}</p>
          <h1>Register</h1>
        </div>
      </header>
      {children}
    </main>
  );
}

/** /register: customer → Load outstanding → cart → Charge (docs/06 Register, docs/05 §2). */
export function RegisterStation() {
  const { session, loaded } = useStationSession();
  if (!loaded) return <Shell session={null}>Opening the register…</Shell>;
  if (!session)
    return (
      <Shell session={null}>
        <p>Sign in as staff or pair this tablet as a station to use the register.</p>
        <div className="station-actions">
          <Link href="/login">Staff sign in</Link>
          <Link href="/pair">Pair device</Link>
        </div>
      </Shell>
    );
  return (
    <Shell session={session}>
      <Register session={session} />
    </Shell>
  );
}

/** What the manager PIN unlocks next. */
type Gate =
  | { kind: "comp" }
  | { kind: "reverse" | "refund"; payment: CartPayment; amount: string; reason: string }
  | {
      kind: "resolve";
      payment: CartPayment;
      outcome: "approved" | "declined" | "cancelled";
      reason: string;
    }
  | {
      kind: "reverse_resolve";
      payment: CartPayment;
      outcome: "voided" | "refunded" | "not_reversed";
      reason: string;
    };

const VIEW_CLASS: Record<ChargeView["tone"], string> = {
  ok: "station-feedback station-ok",
  info: "station-feedback",
  warn: "station-feedback station-rejected",
  bad: "station-feedback station-rejected",
};

export function Register({ session }: { session: StationSession }) {
  const { client, claims } = session;
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState<RetailProduct[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [tender, setTender] = useState<TenderType>("card");
  const [terminalId, setTerminalId] = useState("");
  const [amount, setAmount] = useState("");
  const [tenderRef, setTenderRef] = useState("");
  const [reason, setReason] = useState("");
  const [view, setView] = useState<ChargeView | null>(null);
  const [lastPaymentId, setLastPaymentId] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [gateDraft, setGateDraft] = useState<Gate | null>(null);
  // markable() depends on the clock: re-check it while a payment is still pending, so
  // "Manager: mark…" appears once the in-flight window has passed without another action.
  const [now, setNow] = useState(() => Date.now());
  const hasPending = cart?.payments.some((p) => p.state === "pending") ?? false;
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [hasPending]);
  const sale = useRef<AbortController | null>(null);
  // One client_action_id per intent, reused on retry until it succeeds.
  const intents = useRef<Record<string, string>>({});
  const intent = (key: string) => (intents.current[key] ??= crypto.randomUUID());
  const done = (key: string) => delete intents.current[key];

  useEffect(() => {
    void listRetailProducts(client).then(setProducts, () => setProducts([]));
    void listCardTerminals(client).then(
      (t) => {
        setTerminals(t);
        setTerminalId((cur) => cur || t[0]?.id || "");
      },
      () => setTerminals([]),
    );
  }, [client]);

  function show(next: Cart) {
    setCart(next);
    setAmount(next.state === "open" ? next.totals.due.toFixed(2) : "");
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong; try again.");
    } finally {
      setBusy(false);
    }
  }

  const load = (c: CustomerHit) =>
    run(async () => {
      setCustomer(c);
      const reuse = cart && cart.state === "open" && !cartLocked(cart) ? cart.id : null;
      const next = await loadOutstanding(client, intent("load"), c.id, reuse);
      done("load");
      setNotices(next.notices ?? []);
      setView(null);
      show(next);
    });

  const refresh = async () => {
    if (cart) show(await readCart(client, cart.id));
  };

  async function charge(elevationToken?: string) {
    if (!cart) return;
    const invalid = chargeInputError({
      amount,
      due: cart.totals.due,
      tender,
      terminalId,
      tenderRef,
      reason,
    });
    if (invalid) {
      setError(invalid);
      return;
    }
    setError("");
    setView({
      phase: "present_card",
      tone: "info",
      message: tender === "card" ? "Present card on the terminal." : "Recording…",
    });
    const controller = new AbortController();
    sale.current = controller;
    try {
      const r = await postPayments(
        client,
        "sale",
        {
          clientActionId: intent("charge"),
          orderId: cart.id,
          amount: Number(amount),
          tender,
          terminalId: tender === "card" ? terminalId : null,
          tenderRef: tenderRef || null,
          reason: reason || null,
          elevationToken: elevationToken ?? null,
        },
        controller.signal,
      );
      done("charge");
      setView(chargeView(r));
      if (r.payment.state === "approved") setLastPaymentId(r.payment.id);
      if (r.order) show(r.order);
      setTenderRef("");
      setReason("");
    } catch (err) {
      if (controller.signal.aborted) return; // Cancel took over the panel
      setView({
        phase: "error",
        tone: "bad",
        message: err instanceof Error ? err.message : "Charge failed.",
      });
      await refresh().catch(() => undefined);
    } finally {
      if (sale.current === controller) sale.current = null;
    }
  }

  /** Cancel: tell the terminal to abort and unblock now; the sale's outcome is reconciled. */
  async function cancel() {
    if (!cart) return;
    setView({ phase: "cancelling", tone: "info", message: "Cancelling on the terminal…" });
    const pending = (await readCart(client, cart.id)).payments.find((p) => p.state === "pending");
    sale.current?.abort();
    sale.current = null;
    if (pending) {
      await postPayments(client, "abort", { paymentId: pending.id }).catch(() => undefined);
    }
    done("charge");
    await refresh();
    setView({
      phase: "cancelling",
      tone: "info",
      message:
        "Cancel sent. If the payment still shows pending, use Check status before charging again.",
    });
  }

  const checkStatus = (p: CartPayment) =>
    run(async () => {
      const r = await postPayments(client, "status", { paymentId: p.id });
      setView(chargeView(r));
      if (r.payment.state === "approved") setLastPaymentId(r.payment.id);
      if (r.order) show(r.order);
    });

  async function unlocked(token: string, g: Gate): Promise<void> {
    if (g.kind === "comp") return charge(token);
    if (g.kind === "resolve") {
      const r = await resolvePayment(
        client,
        intent(`resolve:${g.payment.id}`),
        g.payment.id,
        g.outcome,
        g.reason,
        token,
      );
      done(`resolve:${g.payment.id}`);
      setView(chargeView(r));
      if (r.order) show(r.order);
      return;
    }
    if (g.kind === "reverse_resolve") {
      const r = await resolveReversal(
        client,
        intent(`rr:${g.payment.id}`),
        g.payment.id,
        g.outcome,
        g.reason,
        token,
      );
      done(`rr:${g.payment.id}`);
      setView({
        phase: "idle",
        tone: "ok",
        message: `${r.payment.number} resolved: ${g.outcome.replace("_", " ")} (${r.payment.state}).`,
      });
      await refresh();
      return;
    }
    const key = `${g.kind}:${g.payment.id}`;
    const r = await postPayments(client, g.kind, {
      clientActionId: intent(key),
      paymentId: g.payment.id,
      reason: g.reason,
      elevationToken: token,
      ...(g.kind === "refund" ? { amount: Number(g.amount) } : {}),
    });
    done(key);
    setView(
      reversalView(
        g.kind,
        r as unknown as ReversalResult,
        g.kind === "refund" ? Number(g.amount) : undefined,
      ),
    );
    await refresh();
  }

  const blocker = chargeBlocker(cart);
  const locked = cartLocked(cart);
  const charging = view?.phase === "present_card";
  const pendingOnCart = cart?.payments.filter(unresolved) ?? [];

  return (
    <>
      <div className="station-workspace intake-workspace">
        <section className="station-card intake-form" aria-label="Customer and cart">
          <h2>{cart ? `Cart ${cart.number}` : "Customer"}</h2>
          {customer ? (
            <div className="intake-customer">
              <div>
                <strong>{customer.name}</strong>{" "}
                {customer.phone && <span>{formatPhone(customer.phone)}</span>}
              </div>
              <div className="station-actions">
                <button type="button" disabled={busy || locked} onClick={() => void load(customer)}>
                  Reload outstanding
                </button>
                <button
                  type="button"
                  disabled={busy || charging}
                  onClick={() => {
                    setCustomer(null);
                    setCart(null);
                    setNotices([]);
                    setView(null);
                  }}
                >
                  Next customer
                </button>
              </div>
            </div>
          ) : (
            <CustomerSearch
              autoFocus
              label="Customer phone or name"
              search={(q) => searchCustomers(client, claims.orgId, q)}
              onSelect={(c) => void load(c)}
            />
          )}

          {notices.map((n, i) => (
            <p
              key={i}
              className={
                n.level === "error" ? "station-feedback station-rejected" : "station-feedback"
              }
              role={n.level === "error" ? "alert" : undefined}
            >
              {n.message}
            </p>
          ))}

          {cart && (
            <>
              <table className="intake-lines" aria-label="Cart lines">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cart.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <span className="station-badge">{LINE_KIND_LABELS[l.kind]}</span>{" "}
                        {l.description}
                      </td>
                      <td>{l.qty}</td>
                      <td>{money(l.amount)}</td>
                      <td>
                        <button
                          type="button"
                          disabled={busy || locked}
                          onClick={() =>
                            void run(async () => {
                              const next = await removeLine(
                                client,
                                intent(`rm:${l.id}`),
                                cart.id,
                                l.id,
                              );
                              done(`rm:${l.id}`);
                              show(next);
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {cart.lines.length === 0 && (
                    <tr>
                      <td colSpan={4}>Nothing outstanding.</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {products.length > 0 && !locked && (
                <div className="intake-fields">
                  <label>
                    Retail{" "}
                    <select value={productId} onChange={(e) => setProductId(e.target.value)}>
                      <option value="">Add a product…</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {money(p.unit_price)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Qty{" "}
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={qty}
                      onChange={(e) => setQty(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !productId || !(Number(qty) > 0)}
                    onClick={() =>
                      void run(async () => {
                        const next = await addRetail(
                          client,
                          intent(`retail:${productId}`),
                          cart.id,
                          productId,
                          Number(qty),
                        );
                        done(`retail:${productId}`);
                        setProductId("");
                        setQty("1");
                        show(next);
                      })
                    }
                  >
                    Add
                  </button>
                </div>
              )}

              <table className="intake-price-lines" aria-label="Totals">
                <tbody>
                  <tr>
                    <td>Subtotal</td>
                    <td>{money(cart.totals.subtotal)}</td>
                  </tr>
                  <tr>
                    <td>
                      Tax
                      {cart.tax_setting.mode !== "none" &&
                        ` (${(cart.tax_setting.rate * 100).toFixed(2).replace(/\.?0+$/, "")}% ${cart.tax_setting.mode}${
                          cart.tax_setting.cap_amount !== null
                            ? `, max ${money(cart.tax_setting.cap_amount)}`
                            : ""
                        })`}
                    </td>
                    <td>{money(cart.totals.tax)}</td>
                  </tr>
                  <tr>
                    <td>Total</td>
                    <td>{money(cart.totals.total)}</td>
                  </tr>
                  <tr>
                    <td>Paid</td>
                    <td>{money(cart.totals.paid)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="intake-total">Due {money(cart.totals.due)}</p>
            </>
          )}
        </section>

        {cart && (
          <section className="station-card" aria-label="Payment">
            <h2>Payment</h2>
            {blocker && cart.state === "open" && <p className="station-hint">{blocker}</p>}
            {cart.state === "open" && !cart.blocking_payment_id && !cart.reversal_payment_id && (
              <div className="intake-fields">
                <label>
                  Tender{" "}
                  <select
                    value={tender}
                    disabled={charging}
                    onChange={(e) => setTender(e.target.value as TenderType)}
                  >
                    {(Object.keys(TENDER_LABELS) as TenderType[]).map((t) => (
                      <option key={t} value={t}>
                        {TENDER_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
                {tender === "card" && (
                  <label>
                    Terminal{" "}
                    <select
                      value={terminalId}
                      disabled={charging}
                      onChange={(e) => setTerminalId(e.target.value)}
                    >
                      {terminals.length === 0 && <option value="">No card terminal set up</option>}
                      {terminals.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {(tender === "check" || tender === "external") && (
                  <label>
                    {tender === "check" ? "Check #" : "Terminal ref"}{" "}
                    <input value={tenderRef} onChange={(e) => setTenderRef(e.target.value)} />
                  </label>
                )}
                {tender === "comp" && (
                  <label>
                    Reason <input value={reason} onChange={(e) => setReason(e.target.value)} />
                  </label>
                )}
                <label>
                  Amount ${" "}
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    disabled={charging}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-label="Amount"
                  />
                </label>
              </div>
            )}

            {view && (
              <p
                className={VIEW_CLASS[view.tone]}
                role={view.tone === "bad" || view.tone === "warn" ? "alert" : "status"}
              >
                {view.message}
              </p>
            )}
            {error && (
              <p className="station-feedback station-rejected" role="alert">
                {error}
              </p>
            )}

            <div className="station-actions">
              {charging ? (
                <button type="button" onClick={() => void cancel()}>
                  Cancel
                </button>
              ) : (
                cart.state === "open" &&
                !blocker && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (tender === "comp" ? setGate({ kind: "comp" }) : void charge())}
                  >
                    {tender === "card" ? "Charge" : `Record ${TENDER_LABELS[tender]}`}
                  </button>
                )
              )}
              {lastPaymentId && (
                <Link href={`/register/receipt/${lastPaymentId}`} target="_blank">
                  Print receipt
                </Link>
              )}
              {cart.state === "open" && !locked && cart.lines.length > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      show(await voidCart(client, intent("void"), cart.id));
                      done("void");
                    })
                  }
                >
                  Void cart
                </button>
              )}
            </div>

            {pendingOnCart.map((p) => (
              <div key={p.id} className="station-actions">
                <span>{paymentLabel(p)}</span>
                <button
                  type="button"
                  disabled={busy || charging}
                  onClick={() => void checkStatus(p)}
                >
                  Check status
                </button>
                {markable(p, now) ? (
                  <button
                    type="button"
                    disabled={busy || charging}
                    onClick={() =>
                      setGateDraft({ kind: "resolve", payment: p, outcome: "declined", reason: "" })
                    }
                  >
                    Manager: mark…
                  </button>
                ) : (
                  <span className="station-hint">
                    May still be running on the terminal — use Check status.
                  </span>
                )}
              </div>
            ))}

            {cart.payments.length > 0 && (
              <ul className="station-queue" aria-label="Payments">
                {cart.payments.map((p) => (
                  <li key={p.id}>
                    <span>{paymentLabel(p)}</span>
                    <div className="station-actions">
                      {p.state === "approved" && (
                        <Link href={`/register/receipt/${p.id}`} target="_blank">
                          Receipt
                        </Link>
                      )}
                      {reversalUnresolved(p) && (
                        <>
                          <span className="station-badge">
                            {p.reverse_pending_kind === "refund" ? "REFUND" : "VOID"} UNCONFIRMED
                          </span>
                          <button
                            type="button"
                            disabled={busy || charging}
                            onClick={() =>
                              setGateDraft({
                                kind: "reverse_resolve",
                                payment: p,
                                outcome:
                                  p.reverse_pending_kind === "refund" ? "refunded" : "voided",
                                reason: "",
                              })
                            }
                          >
                            Manager: resolve{" "}
                            {p.reverse_pending_kind === "refund" ? "refund" : "void"}…
                          </button>
                        </>
                      )}
                      {reversible(p) && (
                        <>
                          <button
                            type="button"
                            disabled={busy || charging}
                            onClick={() =>
                              setGateDraft({
                                kind: "reverse",
                                payment: p,
                                amount: String(p.refundable ?? p.amount),
                                reason: "",
                              })
                            }
                          >
                            Void
                          </button>
                          <button
                            type="button"
                            disabled={busy || charging}
                            onClick={() =>
                              setGateDraft({
                                kind: "refund",
                                payment: p,
                                amount: String(p.refundable ?? p.amount),
                                reason: "",
                              })
                            }
                          >
                            Refund
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {gateDraft && gateDraft.kind !== "comp" && (
              <div className="station-card" aria-label="Manager action">
                <h3>
                  {gateDraft.kind === "resolve"
                    ? `Mark ${gateDraft.payment.number}`
                    : gateDraft.kind === "reverse_resolve"
                      ? `Resolve the unconfirmed ${gateDraft.payment.reverse_pending_kind === "refund" ? "refund" : "void"} of ${gateDraft.payment.number}`
                      : `${gateDraft.kind === "reverse" ? "Void" : "Refund"} ${gateDraft.payment.number}`}
                </h3>
                {gateDraft.kind === "resolve" && (
                  <label>
                    Outcome{" "}
                    <select
                      value={gateDraft.outcome}
                      onChange={(e) =>
                        setGateDraft({
                          ...gateDraft,
                          outcome: e.target.value as "approved" | "declined" | "cancelled",
                        })
                      }
                    >
                      <option value="declined">Declined (not charged)</option>
                      <option value="cancelled">Cancelled (not charged)</option>
                      <option value="approved">Approved (money captured)</option>
                    </select>
                  </label>
                )}
                {gateDraft.kind === "reverse_resolve" && (
                  <label>
                    What the processor shows{" "}
                    <select
                      value={gateDraft.outcome}
                      onChange={(e) =>
                        setGateDraft({
                          ...gateDraft,
                          outcome: e.target.value as "voided" | "refunded" | "not_reversed",
                        })
                      }
                    >
                      <option value="refunded">Refunded (money returned)</option>
                      <option value="voided">Voided (money returned)</option>
                      <option value="not_reversed">Not reversed (still charged)</option>
                    </select>
                  </label>
                )}
                {gateDraft.kind === "refund" && (
                  <label>
                    Amount ${" "}
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={gateDraft.amount}
                      onChange={(e) => setGateDraft({ ...gateDraft, amount: e.target.value })}
                    />
                  </label>
                )}
                <label>
                  Reason{" "}
                  <input
                    value={gateDraft.reason}
                    onChange={(e) => setGateDraft({ ...gateDraft, reason: e.target.value })}
                  />
                </label>
                <div className="station-actions">
                  <button
                    type="button"
                    disabled={
                      !gateDraft.reason.trim() ||
                      (gateDraft.kind === "refund" && !(Number(gateDraft.amount) > 0))
                    }
                    onClick={() => {
                      setGate(gateDraft);
                      setGateDraft(null);
                    }}
                  >
                    Manager PIN…
                  </button>
                  <button type="button" onClick={() => setGateDraft(null)}>
                    Back
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      {gate && (
        <ManagerPinOverlay
          onClose={() => setGate(null)}
          verify={async (pin) => {
            const elevation = await managerElevation(client, pin);
            if ("reason" in elevation) return { ok: false, reason: elevation.reason };
            const g = gate;
            setGate(null);
            try {
              await unlocked(elevation.token, g);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Manager action failed.");
            }
            return { ok: true };
          }}
        />
      )}
    </>
  );
}
