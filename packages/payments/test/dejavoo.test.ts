// dejavoo_spin adapter (docs/05-PAYMENTS.md §4) against the fake SPIn server — every required
// case of §6 — plus the pure pieces: StatusCode table, payload builder, card meta, scrub.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SPIN_STATUS_CODES,
  buildSpinBody,
  cardMeta,
  classifyStatusCode,
  createDejavooProvider,
  normalizeSpinEndpoint,
  normalizeStatusCode,
  spinAmount,
  spinTerminal,
  type PaymentProvider,
} from "../src/index.ts";
import { FakeSpinServer } from "./fake-spin-server.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let spin: FakeSpinServer;
let provider: PaymentProvider;
let n = 0;
/** a register ref: <order-hex-24>-<attempt> */
const newRef = (attempt = 1) => `${(++n).toString(16).padStart(24, "0")}-${attempt}`;

beforeEach(async () => {
  spin = await FakeSpinServer.start();
  // the HTTP timeout is SPInProxyTimeout + this buffer; short so timeouts are quick to test
  provider = createDejavooProvider({ transportBufferMs: 150 });
});

afterEach(async () => {
  await spin.close();
});

const sale = (amount: number, ref: string, timeoutMs = 1000, terminal = spin.terminal()) =>
  provider.sale({ terminal, amount, ref, timeoutMs });

describe("§6 required cases (fake SPIn server)", () => {
  it("approved: one Sale with the exact body docs/05 §4 lists; card meta and txn come back", async () => {
    const ref = newRef();
    const r = await sale(25, ref, 120_000);
    expect(r).toMatchObject({
      outcome: "approved",
      approvedAmount: 25,
      providerRef: ref,
      providerTxn: "1001",
      card: {
        brand: "VISA",
        last4: "4242",
        entryMode: "chip",
        authCode: "A1B2C3",
        hostResponseCode: "00",
      },
    });
    const [body] = spin.requestsOf("Sale");
    expect(body).toEqual({
      PaymentType: "Credit",
      ReferenceId: ref,
      Amount: 25,
      PrintReceipt: "No",
      GetReceipt: "No",
      CaptureSignature: false,
      GetExtendedData: true,
      SPInProxyTimeout: 120,
      Tpn: spin.opts.tpn,
      Authkey: spin.opts.authkey,
    });
    expect(typeof body!.Amount).toBe("number");
    expect(body).not.toHaveProperty("RegisterId");
    expect(spin.charges).toBe(1);
  });

  it("partial approval (0001): approved for the captured amount, not the requested one", async () => {
    spin.queue("Sale", { statusCode: "0001", amount: 10, hostResponseCode: "10" });
    const r = await sale(25, newRef());
    expect(r).toMatchObject({ outcome: "approved", approvedAmount: 10 });
    expect(r.message).toMatch(/Partially approved: \$10\.00 of \$25\.00/);
  });

  it("declined by the issuer as 1012: HostResponseCode ≠ 00 → declined with the bank's reason, never 'cancelled'", async () => {
    spin.queue("Sale", {
      statusCode: "1012",
      hostResponseCode: "51",
      hostResponseMessage: "INSUFFICIENT FUNDS",
    });
    const r = await sale(25, newRef());
    expect(r.outcome).toBe("declined");
    expect(r.card).toMatchObject({ hostResponseCode: "51", declineReason: "INSUFFICIENT FUNDS" });
    expect(r.message).toBe("Declined: INSUFFICIENT FUNDS.");
    expect(r.message).not.toMatch(/cancel/i);
    expect(spin.charges).toBe(0);
  });

  it("declined (1015) carries the reason too", async () => {
    spin.queue("Sale", {
      statusCode: "1015",
      hostResponseCode: "05",
      hostResponseMessage: "DO NOT HONOR",
    });
    expect(await sale(25, newRef())).toMatchObject({
      outcome: "declined",
      card: { declineReason: "DO NOT HONOR" },
    });
  });

  it("cashier cancel: AbortTransaction for the ref releases the waiting Sale → cancelled", async () => {
    const ref = newRef();
    spin.queue("Sale", { hold: true });
    const pending = sale(25, ref, 5000);
    while (spin.requestsOf("Sale").length === 0) await sleep(10);
    const aborted = await provider.abort({ terminal: spin.terminal(), ref });
    expect(aborted.ok).toBe(true);
    const r = await pending;
    expect(r).toMatchObject({ outcome: "cancelled", message: "Cancelled on the terminal." });
    expect(spin.requestsOf("AbortTransaction")[0]).toMatchObject({ ReferenceId: ref });
    expect(spin.charges).toBe(0);
  });

  it("timeout → status approved: the HTTP call gives up (indeterminate), Status finds the approval", async () => {
    const ref = newRef();
    spin.queue("Sale", { delayMs: 1600 });
    const r = await sale(25, ref, 1000); // SPInProxyTimeout 1 s + 150 ms buffer
    expect(r.outcome).toBe("indeterminate");
    expect(r.message).toMatch(/checking status/);
    while (!spin.txns.has(ref)) await sleep(20); // the customer finishes on the terminal
    const s = await provider.status({ terminal: spin.terminal(), ref });
    expect(s).toMatchObject({ outcome: "approved", approvedAmount: 25, providerTxn: "1001" });
    expect(spin.requestsOf("Status")[0]).toMatchObject({
      ReferenceId: ref,
      OriginalReferenceId: ref,
    });
    expect(spin.charges).toBe(1);
  });

  it("timeout → status approved: an indeterminate StatusCode (2007) is reconciled by Status", async () => {
    const ref = newRef();
    spin.queue("Sale", { statusCode: "2007", message: "Terminal timeout" });
    expect((await sale(25, ref)).outcome).toBe("indeterminate");
    spin.queue("Status", { statusCode: "0000", amount: 25, transNum: "777" });
    expect(await provider.status({ terminal: spin.terminal(), ref, txn: undefined })).toMatchObject(
      {
        outcome: "approved",
        approvedAmount: 25,
        providerTxn: "777",
      },
    );
  });

  it("timeout → status cancelled", async () => {
    const ref = newRef();
    spin.queue("Sale", { delayMs: 1600 });
    expect((await sale(25, ref, 1000)).outcome).toBe("indeterminate");
    spin.queue("Status", { statusCode: "1012", message: "Aborted" });
    expect((await provider.status({ terminal: spin.terminal(), ref })).outcome).toBe("cancelled");
  });

  it("status that cannot look the sale up (lookup / transport) proves nothing: indeterminate", async () => {
    const ref = newRef();
    expect((await provider.status({ terminal: spin.terminal(), ref })).outcome).toBe(
      "indeterminate",
    );
    spin.queue("Status", { http: 503, rawBody: "Service Unavailable" });
    expect((await provider.status({ terminal: spin.terminal(), ref })).outcome).toBe(
      "indeterminate",
    );
  });

  it("transport error, nothing sent (connection refused): error — safe to retry", async () => {
    const url = spin.url;
    await spin.close();
    const r = await sale(25, newRef(), 1000, { ...spin.terminal(), endpoint_url: url });
    expect(r.outcome).toBe("error");
    expect(r.message).toMatch(
      /Could not reach the terminal \(ECONNREFUSED\)\. Nothing was charged/,
    );
    spin = await FakeSpinServer.start(); // for afterEach
  });

  it("transport error after the request was sent (5xx, unparseable body): indeterminate → status", async () => {
    spin.queue("Sale", { http: 502, rawBody: "<html>Bad Gateway</html>" });
    expect((await sale(25, newRef())).outcome).toBe("indeterminate");
    spin.queue("Sale", { http: 200, rawBody: "not json" });
    expect((await sale(25, newRef())).outcome).toBe("indeterminate");
  });

  it("a 4xx JSON validation answer is parsed, not thrown", async () => {
    spin.queue("Sale", { http: 400, statusCode: "1002", message: "Amount is required" });
    const r = await sale(25, newRef());
    expect(r.outcome).toBe("error");
    expect(r.message).toMatch(/rejected the request \(1002 Amount is required\)/);
  });

  it("a JSON 4xx WITHOUT a SPIn StatusCode (e.g. an intermediary's 408) proves nothing: indeterminate, never retryable", async () => {
    const noCode = (http: number) => ({
      http,
      rawBody: JSON.stringify({
        message: "Request Timeout",
        GeneralResponse: { Message: "upstream" },
      }),
    });
    const ref = newRef();
    spin.queue("Sale", noCode(408));
    const r = await sale(25, ref);
    expect(r.outcome).toBe("indeterminate");
    expect(r.message).not.toMatch(/Nothing was charged/);

    spin.queue("Status", noCode(404));
    expect((await provider.status({ terminal: spin.terminal(), ref })).outcome).toBe(
      "indeterminate",
    );

    spin.queue("Void", noCode(408));
    expect((await provider.reverse({ terminal: spin.terminal(), originalRef: ref })).outcome).toBe(
      "indeterminate",
    );
    spin.queue("Return", noCode(400));
    expect(
      (await provider.refund({ terminal: spin.terminal(), amount: 5, ref: `${ref}-R1` })).outcome,
    ).toBe("indeterminate");
  });

  it("config error: RegisterId set to one the proxy does not know → 2003 'Register not found'", async () => {
    const r = await sale(25, newRef(), 1000, spin.terminal({ register_id: "REG-PLACEHOLDER" }));
    expect(r.outcome).toBe("error");
    expect(r.message).toMatch(/Terminal setup problem \(2003 Register not found\)/);
    expect(spin.requestsOf("Sale")[0]).toMatchObject({ RegisterId: "REG-PLACEHOLDER" });
  });

  it("config error: a wrong Authkey is a setup error, and the stored raw never carries the key", async () => {
    const r = await sale(25, newRef(), 1000, spin.terminal({ secret: "WRONG-AUTHKEY-abc" }));
    expect(r.outcome).toBe("error");
    expect(r.message).toMatch(/1017/);
    expect(JSON.stringify(r.raw)).not.toContain("WRONG-AUTHKEY-abc");
    expect(JSON.stringify(provider.scrub(r.raw))).not.toContain("WRONG-AUTHKEY-abc");
  });

  it("config error before any request: missing TPN / Authkey / host → error, nothing sent", async () => {
    for (const terminal of [
      spin.terminal({ tpn: "" }),
      spin.terminal({ secret: "" }),
      spin.terminal({ endpoint_url: "http://evil.example.com" }),
      spin.terminal({ timeout_secs: 600 }),
    ]) {
      expect((await sale(25, newRef(), 1000, terminal)).outcome).toBe("error");
    }
    expect(spin.requests).toHaveLength(0);
  });

  it("a configured RegisterId the proxy knows is sent", async () => {
    await spin.close();
    spin = await FakeSpinServer.start({ registerId: "R1" });
    expect((await sale(25, newRef(), 1000, spin.terminal({ register_id: "R1" }))).outcome).toBe(
      "approved",
    );
    expect(spin.requestsOf("Sale")[0]).toMatchObject({ RegisterId: "R1" });
  });

  it("reverse → void: /Void with the original ref (and txn) and its own ReferenceId; ProcessedAs Void", async () => {
    const ref = newRef();
    const approved = await sale(25, ref);
    const r = await provider.reverse({
      terminal: spin.terminal(),
      originalRef: ref,
      originalTxn: approved.providerTxn,
      amount: 25,
    });
    expect(r).toMatchObject({ outcome: "voided" });
    const [body] = spin.requestsOf("Void");
    expect(body).toMatchObject({
      OriginalReferenceId: ref,
      OriginalTransNum: approved.providerTxn,
      Amount: 25,
      PrintReceipt: "No",
    });
    expect(body!.ReferenceId).not.toBe(ref);
    expect(String(body!.ReferenceId).startsWith(`${ref}-V`)).toBe(true);
    expect(r.raw).toMatchObject({ processedAs: "Void" });
  });

  it("reverse → refund: after the batch Dejavoo refunds instead (ProcessedAs Return)", async () => {
    const ref = newRef();
    await sale(25, ref);
    spin.queue("Void", { processedAs: "Return" });
    const r = await provider.reverse({ terminal: spin.terminal(), originalRef: ref, amount: 25 });
    expect(r).toMatchObject({ outcome: "refunded", raw: { processedAs: "Return" } });
  });

  it("reverse that may have reached the terminal without an answer is indeterminate (never refund twice)", async () => {
    const ref = newRef();
    await sale(25, ref);
    spin.queue("Void", { http: 500, rawBody: "oops" });
    expect((await provider.reverse({ terminal: spin.terminal(), originalRef: ref })).outcome).toBe(
      "indeterminate",
    );
    spin.queue("Void", { statusCode: "1015", hostResponseCode: "05" });
    expect((await provider.reverse({ terminal: spin.terminal(), originalRef: ref })).outcome).toBe(
      "declined",
    );
    spin.queue("Void", { statusCode: "1011", message: "Original not found" });
    expect((await provider.reverse({ terminal: spin.terminal(), originalRef: ref })).outcome).toBe(
      "error",
    );
  });

  it("refund: /Return with the refund ref, amount and original TransNum", async () => {
    const ref = newRef();
    const approved = await sale(25, ref);
    const r = await provider.refund({
      terminal: spin.terminal(),
      amount: 10,
      ref: `${ref}-R1`,
      originalTxn: approved.providerTxn,
    });
    expect(r.outcome).toBe("refunded");
    expect(spin.requestsOf("Return")[0]).toMatchObject({
      ReferenceId: `${ref}-R1`,
      Amount: 10,
      OriginalTransNum: approved.providerTxn,
    });
  });

  it("duplicate ref rejected: the proxy refuses a reused ReferenceId and nothing is charged twice", async () => {
    const ref = newRef();
    expect((await sale(25, ref)).outcome).toBe("approved");
    const again = await sale(25, ref);
    expect(again.outcome).toBe("error");
    expect(again.message).toMatch(/Duplicate ReferenceId/);
    expect(spin.charges).toBe(1);
  });

  it("retry uses a new ref: attempt 2 after a decline is a fresh ReferenceId the proxy accepts", async () => {
    const first = newRef(1);
    const second = first.replace(/-1$/, "-2");
    spin.queue("Sale", { statusCode: "1012", hostResponseCode: "51", hostResponseMessage: "NSF" });
    expect((await sale(25, first)).outcome).toBe("declined");
    expect((await sale(25, second)).outcome).toBe("approved");
    expect(spin.requestsOf("Sale").map((b) => b.ReferenceId)).toEqual([first, second]);
    expect(spin.charges).toBe(1);
  });
});

describe("StatusCode classification (docs/05 §4, verbatim)", () => {
  it("maps every listed code to its class", () => {
    const expected: Record<string, string> = {};
    for (const [cls, codes] of Object.entries(SPIN_STATUS_CODES)) {
      for (const c of codes) expected[c] = cls;
    }
    expect(expected).toEqual({
      ...Object.fromEntries(["0000", "0001", "1500"].map((c) => [c, "approved"])),
      "1012": "cancelled",
      "1015": "declined",
      ...Object.fromEntries(
        "1000 1005 1006 1030 1999 2001 2007 2008 2010 2011 2110"
          .split(" ")
          .map((c) => [c, "indeterminate"]),
      ),
      ...Object.fromEntries(
        "1002 1003 1004 1007 1008 1013 1016 2006 2102 2201"
          .split(" ")
          .map((c) => [c, "bad_request"]),
      ),
      ...Object.fromEntries(
        "1009 1017 1019 1020 1024 2002 2003 2004 2005 2101"
          .split(" ")
          .map((c) => [c, "config_error"]),
      ),
      ...Object.fromEntries("1001 1010 1011 2009 2301".split(" ").map((c) => [c, "lookup_error"])),
    });
    for (const [code, cls] of Object.entries(expected)) expect(classifyStatusCode(code)).toBe(cls);
  });

  it("an unlisted or missing code is unknown; numeric codes are padded", () => {
    expect(classifyStatusCode("4242")).toBe("unknown");
    expect(classifyStatusCode(undefined)).toBe("unknown");
    expect(normalizeStatusCode(0)).toBe("0000");
    expect(normalizeStatusCode(1012)).toBe("1012");
    expect(normalizeStatusCode("x")).toBeUndefined();
  });

  it("classifies on StatusCode, never ResultCode", async () => {
    const answer = (body: unknown) =>
      createDejavooProvider({
        fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      }).sale({
        terminal: { endpoint_url: "spinpos.net", tpn: "TPN1", secret: "k" },
        amount: 5,
        ref: "r-1",
        timeoutMs: 1000,
      });
    expect(
      (
        await answer({
          GeneralResponse: { StatusCode: "0000", ResultCode: "1" },
          Amounts: { Amount: 5 },
        })
      ).outcome,
    ).toBe("approved");
    expect(
      (await answer({ GeneralResponse: { StatusCode: "1012", ResultCode: "0" } })).outcome,
    ).toBe("cancelled");
    // unknown code: never assume — indeterminate
    expect(
      (await answer({ GeneralResponse: { StatusCode: "4242", ResultCode: "0" } })).outcome,
    ).toBe("indeterminate");
    // conflicting signals: host 00 on a non-approval → indeterminate (Status reconciles)
    expect(
      (await answer({ GeneralResponse: { StatusCode: "1012", HostResponseCode: "00" } })).outcome,
    ).toBe("indeterminate");
    // 0001 without an amount cannot be recorded safely
    expect((await answer({ GeneralResponse: { StatusCode: "0001" } })).outcome).toBe(
      "indeterminate",
    );
  });
});

describe("payload builder", () => {
  const t = spinTerminal({ endpoint_url: "dev.spinpos.net", tpn: "TPN1", secret: "k" });

  it("Amount is numeric in cents precision; non-cent or non-positive amounts are refused", () => {
    expect(spinAmount(25)).toBe(25);
    expect(spinAmount(25.5)).toBe(25.5);
    expect(spinAmount(0.1 + 0.2)).toBe(0.3);
    expect(() => spinAmount(25.001)).toThrow(RangeError);
    expect(() => spinAmount(0)).toThrow(RangeError);
    expect(() => spinAmount(Number.NaN)).toThrow(RangeError);
  });

  it("RegisterId is omitted unless the config sets one (blank counts as unset)", () => {
    expect(buildSpinBody(t, { referenceId: "r", proxyTimeoutSecs: 120 })).not.toHaveProperty(
      "RegisterId",
    );
    const blank = spinTerminal({
      endpoint_url: "spinpos.net",
      tpn: "TPN1",
      register_id: "  ",
      secret: "k",
    });
    expect(buildSpinBody(blank, { referenceId: "r", proxyTimeoutSecs: 120 })).not.toHaveProperty(
      "RegisterId",
    );
  });

  it("host is per terminal: bare host → https; http only on loopback; no paths", () => {
    expect(t.baseUrl).toBe("https://dev.spinpos.net");
    expect(normalizeSpinEndpoint("https://spinpos.net/")).toBe("https://spinpos.net");
    expect(normalizeSpinEndpoint("SPINPOS.NET:8443")).toBe("https://spinpos.net:8443");
    expect(normalizeSpinEndpoint("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    expect(normalizeSpinEndpoint("http://spinpos.net")).toBeNull();
    expect(normalizeSpinEndpoint("https://spinpos.net/v2/Payment")).toBeNull();
    expect(normalizeSpinEndpoint("https://user@spinpos.net")).toBeNull();
    expect(normalizeSpinEndpoint("")).toBeNull();
  });

  it("the terminal timeout (30–180 s) overrides the register's wait", async () => {
    const spinServer = await FakeSpinServer.start();
    try {
      await createDejavooProvider().sale({
        terminal: spinServer.terminal({ timeout_secs: 90 }),
        amount: 1,
        ref: "t-1",
        timeoutMs: 120_000,
      });
      expect(spinServer.requestsOf("Sale")[0]).toMatchObject({ SPInProxyTimeout: 90 });
    } finally {
      await spinServer.close();
    }
  });
});

describe("card meta merge", () => {
  it("merges ExtData (k=v string), ExtendedDataByApplication.<brand> and CardData; never a PAN", () => {
    const meta = cardMeta({
      GeneralResponse: { StatusCode: "0000", HostResponseCode: "00" },
      AuthCode: "XYZ123",
      CardData: { CardType: "Mastercard", EntryType: "Contactless" },
      ExtData: "AcntLast=XXXXXXXXXXXX5454,iPOSToken=tok_abc=,Pan=5454545454545454",
      ExtendedDataByApplication: { Mastercard: { AppLabel: "MASTERCARD", Token: "app-token" } },
    });
    expect(meta).toEqual({
      brand: "Mastercard",
      last4: "5454",
      entryMode: "contactless",
      authCode: "XYZ123",
      hostResponseCode: "00",
      token: "tok_abc=",
    });
  });

  it("reads last4 under Last4 | AcntLast4 | AcntLast and the token under IPosToken | iPOSToken | Token", () => {
    expect(
      cardMeta({ CardData: { AcntLast4: "1111" }, ExtData: { IPosToken: "t1" } }),
    ).toMatchObject({
      last4: "1111",
      token: "t1",
    });
    expect(cardMeta({ ExtData: "AcntLast=9999,Token=t2" })).toMatchObject({
      last4: "9999",
      token: "t2",
    });
    expect(
      cardMeta({ ExtendedDataByApplication: { VISA: { Last4: "4242", EntryMode: "Swipe" } } }),
    ).toMatchObject({
      last4: "4242",
      entryMode: "swipe",
    });
    expect(cardMeta({ CardData: { Last4: "12" } }).last4).toBeUndefined();
  });
});

describe("scrub", () => {
  it("redacts Authkey, AccountNumber, Pan and FullCardNumber, and masks card numbers in text", () => {
    const s = provider.scrub({
      request: { Authkey: "AK-1", Tpn: "TPN1" },
      response: {
        AccountNumber: "4111111111111111",
        Pan: "4111",
        FullCardNumber: "4111 1111 1111 1111",
      },
      error: 'fetch failed {"Authkey":"AK-2"} card 4111111111111111',
    });
    const text = JSON.stringify(s);
    for (const secret of ["AK-1", "AK-2", "4111111111111111", "4111 1111"])
      expect(text).not.toContain(secret);
    expect(s).toMatchObject({ request: { Tpn: "TPN1", Authkey: "[redacted]" } });
    expect(text).toContain("************1111");
  });

  it("every raw an operation returns is already scrubbed of the Authkey", async () => {
    const ref = newRef();
    const raws = [
      (await sale(25, ref)).raw,
      (await provider.status({ terminal: spin.terminal(), ref })).raw,
      (await provider.abort({ terminal: spin.terminal(), ref })).raw,
      (await provider.reverse({ terminal: spin.terminal(), originalRef: ref })).raw,
      (await provider.refund({ terminal: spin.terminal(), amount: 1, ref: `${ref}-R1` })).raw,
    ];
    for (const raw of raws) expect(JSON.stringify(raw)).not.toContain(spin.opts.authkey);
  });
});
