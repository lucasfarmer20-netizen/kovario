import { randomUUID } from "node:crypto";
import { PLAN_CODES, PLANS, type PlanLimits } from "payments";
import { startCheckout } from "@/app/admin/subscription/actions";
import { ActionForm } from "@/components/admin/action-form";
import { cn } from "@/lib/utils";

function limit(n: number | null, one: string, many: string): string {
  return n === null ? `Unlimited ${many}` : `${n} ${n === 1 ? one : many}`;
}

export function limitLines(l: PlanLimits): string[] {
  return [
    limit(l.sites, "site", "sites"),
    limit(l.stations, "station device", "station devices"),
    limit(l.users, "user", "users"),
    l.sms ? "SMS notifications" : "Email notifications",
  ];
}

/** The five DECISION-06 tiers; "Choose" opens Stripe Checkout (owner only). */
export function PlanPicker({
  current,
  canBuy,
  returnTo = "subscription",
}: {
  current: string | null;
  canBuy: boolean;
  returnTo?: "subscription" | "onboarding";
}) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {PLAN_CODES.map((code) => {
        const plan = PLANS[code];
        return (
          <li
            key={code}
            className={cn(
              "flex flex-col gap-2 rounded-md border border-border p-4",
              current === code && "border-primary",
            )}
          >
            <h3 className="font-semibold">{plan.name}</h3>
            <p className="text-2xl font-semibold">
              ${plan.monthlyUsd}
              <span className="text-sm font-normal text-muted-foreground">/month</span>
            </p>
            <ul className="text-sm text-muted-foreground">
              {limitLines(plan.limits).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {current === code ? (
              <p className="text-sm font-medium">Current plan</p>
            ) : canBuy ? (
              <ActionForm action={startCheckout} actionId={randomUUID()} submitLabel="Choose">
                <input type="hidden" name="plan" value={code} />
                <input type="hidden" name="return_to" value={returnTo} />
              </ActionForm>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
