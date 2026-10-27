import { randomUUID } from "node:crypto";
import { PLANS, isPlanCode, limitsFor } from "payments";
import { ActionForm } from "@/components/admin/action-form";
import { PlanPicker, limitLines } from "@/components/billing/plan-picker";
import { adminPageSession } from "@/lib/auth";
import { planState } from "@/lib/plan";
import { openPortal } from "./actions";

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const session = await adminPageSession();
  if (!session) return null;
  const { checkout } = await searchParams;
  const [{ data: org }, { plan, usage }] = await Promise.all([
    session.supabase.from("org").select("subscription_status, stripe_customer_id").maybeSingle(),
    planState(session.supabase),
  ]);
  const isOwner = session.claims.appRole === "owner";
  const limits = limitsFor(plan);
  const rows = [
    ["Sites", usage.sites, limits.sites],
    ["Station devices", usage.stations, limits.stations],
    ["Users", usage.users, limits.users],
  ] as const;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Subscription</h1>
        {checkout === "success" ? (
          <p role="status" className="text-sm">
            Thanks! Your plan appears here as soon as Stripe confirms the payment (usually a few
            seconds — refresh the page).
          </p>
        ) : checkout === "cancelled" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checkout was cancelled; nothing was charged.
          </p>
        ) : null}
        <p>
          {isPlanCode(plan) ? (
            <>
              Current plan: <strong>{PLANS[plan].name}</strong> (${PLANS[plan].monthlyUsd}/month)
              {org?.subscription_status && org.subscription_status !== "active"
                ? ` · ${org.subscription_status.replace("_", " ")}`
                : null}
            </>
          ) : (
            <>
              No subscription yet. Until you choose a plan, Filletry allows{" "}
              {limitLines(limits).slice(0, 3).join(", ").toLowerCase()}.
            </>
          )}
        </p>
        {!isOwner ? (
          <p className="text-sm text-muted-foreground">Only the owner can change the plan.</p>
        ) : org?.stripe_customer_id ? (
          <ActionForm action={openPortal} actionId={randomUUID()} submitLabel="Manage billing">
            <span className="text-sm text-muted-foreground">
              Change plan, card or cancel in the Stripe customer portal.
            </span>
          </ActionForm>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Usage</h2>
        <table className="w-fit text-sm">
          <tbody>
            {rows.map(([label, used, max]) => (
              <tr key={label}>
                <td className="py-1 pr-6">{label}</td>
                <td className="py-1">
                  {used} / {max ?? "unlimited"}
                </td>
              </tr>
            ))}
            <tr>
              <td className="py-1 pr-6">SMS notifications</td>
              <td className="py-1">{limits.sms ? "included" : "not included"}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Plans</h2>
        <PlanPicker current={isPlanCode(plan) ? plan : null} canBuy={isOwner && !plan} />
      </section>
    </div>
  );
}
