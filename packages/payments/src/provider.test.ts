import { describe, expect, it } from "vitest";
import { FakeProvider } from "./fake";
import { manualProvider } from "./manual";
import { ProviderUnavailableError, providerFor } from "./registry";
import { REDACTED, scrubSecrets } from "./scrub";

const terminal = { secret: "" };
const sale = (tender?: Parameters<typeof manualProvider.sale>[0]["tender"]) =>
  manualProvider.sale({ terminal, amount: 42.5, ref: "abc-1", timeoutMs: 1000, tender });

describe("manual adapter (docs/05 §3)", () => {
  it("cash is approved at once for the full amount, entry mode manual", async () => {
    const r = await sale({ type: "cash" });
    expect(r).toMatchObject({
      outcome: "approved",
      approvedAmount: 42.5,
      providerRef: "abc-1",
      card: { entryMode: "manual" },
      message: "Cash recorded.",
    });
  });

  it("check and external terminal record their reference as the provider txn", async () => {
    expect(await sale({ type: "check", reference: " 1042 " })).toMatchObject({
      outcome: "approved",
      providerTxn: "1042",
      message: "Check #1042 recorded.",
    });
    expect((await sale({ type: "external", reference: "T-77" })).providerTxn).toBe("T-77");
  });

  it("refuses a missing tender, a card tender, a check without a number and a COMP without a reason", async () => {
    expect((await sale()).outcome).toBe("error");
    expect((await sale({ type: "card" })).outcome).toBe("error");
    expect((await sale({ type: "check" })).message).toMatch(/reference/);
    expect((await sale({ type: "comp", reason: " " })).message).toMatch(/reason/);
    expect((await sale({ type: "comp", reason: "owner's cousin" })).message).toBe("COMP recorded.");
  });

  it("status cannot decide a manual payment; reverse voids; refund refunds", async () => {
    expect((await manualProvider.status({ terminal, ref: "abc-1" })).outcome).toBe("indeterminate");
    expect((await manualProvider.abort({ terminal, ref: "abc-1" })).ok).toBe(true);
    expect((await manualProvider.reverse({ terminal, originalRef: "abc-1" })).outcome).toBe(
      "voided",
    );
    expect((await manualProvider.refund({ terminal, amount: 5, ref: "abc-1-r" })).outcome).toBe(
      "refunded",
    );
  });
});

describe("fake provider (test harness)", () => {
  it("defaults: approves in full with card meta; status unknown; reverse voids", async () => {
    const p = new FakeProvider();
    const r = await p.sale({ terminal, amount: 10, ref: "r-1", timeoutMs: 10 });
    expect(r).toMatchObject({ outcome: "approved", approvedAmount: 10, card: { last4: "4242" } });
    expect((await p.status({ terminal, ref: "r-1" })).outcome).toBe("indeterminate");
    expect((await p.reverse({ terminal, originalRef: "r-1" })).outcome).toBe("voided");
    expect((await p.refund({ terminal, amount: 1, ref: "r-1" })).outcome).toBe("refunded");
  });

  it("partial approval, scripted declines and statuses", async () => {
    const p = new FakeProvider()
      .queueSale(
        { outcome: "approved", approvedAmount: 6 },
        { outcome: "declined", message: "Insufficient funds" },
      )
      .queueStatus({ outcome: "approved" })
      .queueReverse({ outcome: "refunded" })
      .queueRefund({ outcome: "declined" });
    expect((await p.sale({ terminal, amount: 10, ref: "a", timeoutMs: 10 })).approvedAmount).toBe(
      6,
    );
    expect(await p.sale({ terminal, amount: 4, ref: "b", timeoutMs: 10 })).toMatchObject({
      outcome: "declined",
      message: "Insufficient funds",
    });
    expect((await p.status({ terminal, ref: "b" })).outcome).toBe("approved");
    expect((await p.reverse({ terminal, originalRef: "a" })).outcome).toBe("refunded");
    expect((await p.refund({ terminal, amount: 1, ref: "a" })).outcome).toBe("declined");
    expect(p.callsOf("sale")).toHaveLength(2);
  });

  it("rejects a reused reference (retry uses a new ref)", async () => {
    const p = new FakeProvider();
    await p.sale({ terminal, amount: 1, ref: "dup", timeoutMs: 10 });
    expect((await p.sale({ terminal, amount: 1, ref: "dup", timeoutMs: 10 })).message).toBe(
      "Duplicate reference",
    );
  });

  it("a held sale waits for the cashier's Cancel and reports cancelled", async () => {
    const p = new FakeProvider().queueSale({ outcome: "approved", hold: true });
    const pending = p.sale({ terminal, amount: 1, ref: "h", timeoutMs: 10 });
    await Promise.resolve();
    expect((await p.abort({ terminal, ref: "h" })).raw).toEqual({ fake: true, held: true });
    expect((await pending).outcome).toBe("cancelled");
  });

  it("can delay or throw", async () => {
    const p = new FakeProvider().queueSale(
      { outcome: "approved", delayMs: 1 },
      { outcome: "error", throws: "socket hang up" },
    );
    expect((await p.sale({ terminal, amount: 1, ref: "d", timeoutMs: 10 })).outcome).toBe(
      "approved",
    );
    await expect(p.sale({ terminal, amount: 1, ref: "t", timeoutMs: 10 })).rejects.toThrow(
      "socket hang up",
    );
  });

  it("a reversal can be performed and then throw (a transport failure after the money moved)", async () => {
    const p = new FakeProvider()
      .queueRefund({ outcome: "refunded", throwsAfter: "socket hang up" })
      .queueReverse({ outcome: "voided", throwsAfter: "timeout" });
    await expect(p.refund({ terminal, amount: 1, ref: "r" })).rejects.toThrow("socket hang up");
    await expect(p.reverse({ terminal, originalRef: "r" })).rejects.toThrow("timeout");
    expect(p.performed).toBe(2);
  });

  it("scrubs the terminal secret from recorded calls", async () => {
    const p = new FakeProvider();
    await p.sale({
      terminal: { secret: "AUTHKEY-123", tpn: "T1" },
      amount: 1,
      ref: "s",
      timeoutMs: 10,
    });
    expect(JSON.stringify(p.calls)).not.toContain("AUTHKEY-123");
  });
});

describe("scrub", () => {
  it("redacts secret keys at any depth and masks card numbers", () => {
    const out = scrubSecrets({
      Authkey: "k",
      nested: {
        auth_key: "k",
        list: [{ PAN: "4111111111111111" }],
        note: "card 4111 1111 1111 1111 ok",
      },
      Tpn: "T1",
      gone: null,
    });
    expect(out).toEqual({
      Authkey: REDACTED,
      nested: { auth_key: REDACTED, list: [{ PAN: REDACTED }], note: "card ************1111 ok" },
      Tpn: "T1",
      gone: null,
    });
  });

  it("takes adapter-specific keys and survives cycles", () => {
    const a: Record<string, unknown> = { RegisterSecret: "x", n: 1 };
    a.self = a;
    expect(scrubSecrets(a, ["register_secret"])).toEqual({
      RegisterSecret: REDACTED,
      n: 1,
      self: "[circular]",
    });
  });
});

describe("registry", () => {
  it("manual is always available; card adapters land in WP-17/18", () => {
    expect(providerFor("manual")).toBe(manualProvider);
    expect(() => providerFor("dejavoo_spin")).toThrow(ProviderUnavailableError);
  });
});
