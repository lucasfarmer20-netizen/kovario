"use client";

import { useState } from "react";
import { CUSTOMER_STAGES } from "rules";
import { lookupStatus, type StatusResult } from "./actions";

export function StatusForm({ orgSlug }: { orgSlug: string }) {
  const [result, setResult] = useState<StatusResult | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setPending(true);
          setResult(null);
          try {
            setResult(await lookupStatus(orgSlug, String(form.get("phone") ?? "")));
          } catch {
            setResult({ error: "Unable to connect. Please try again." });
          } finally {
            setPending(false);
          }
        }}
      >
        <label htmlFor="phone">Phone number</label>
        <input
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          required
          maxLength={80}
          className="min-h-14 rounded-md border p-3"
        />
        <button
          type="submit"
          disabled={pending}
          className="min-h-14 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Looking up…" : "Check status"}
        </button>
      </form>
      <section aria-live="polite" className="flex flex-col gap-4">
        {result &&
          ("error" in result ? (
            <p role="alert">{result.error}</p>
          ) : (
            <>
              <h2 className="text-xl font-semibold">{result.org_name}</h2>
              <p>Pickup hours: {result.pickup_hours || "Contact the plant for pickup hours."}</p>
              {result.rates_notice && <p>{result.rates_notice}</p>}
              {result.intakes.length === 0 && <p>No open orders found for this number.</p>}
              {result.intakes.map((i) => (
                <article key={i.number} className="rounded-lg border p-4">
                  <h3 className="font-semibold">
                    Order {i.number} · {CUSTOMER_STAGES[i.state]}
                  </h3>
                  <p>
                    Estimated pickup:{" "}
                    {i.estimated_pickup_at
                      ? new Date(i.estimated_pickup_at).toLocaleString("en-US", {
                          timeZone: result.timezone,
                        })
                      : "Ask the plant"}
                  </p>
                  <p>
                    Amount due:{" "}
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                      i.amount_due,
                    )}
                  </p>
                </article>
              ))}
            </>
          ))}
      </section>
    </>
  );
}
