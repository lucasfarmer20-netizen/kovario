import Link from "next/link";
import type { ReactNode } from "react";
import { isManager } from "db";
import { Button } from "@/components/ui/form";
import { requireStaff } from "@/lib/auth";
import { signOut } from "../login/actions";

const NAV = [
  { href: "/reports", label: "Reports" },
  { href: "/admin/asset-tags", label: "Asset tags" },
  { href: "/admin/locations", label: "Locations" },
  { href: "/admin/printers", label: "Printers" },
  { href: "/admin/print-agents", label: "Print agents" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/devices", label: "Devices" },
  { href: "/admin/sites", label: "Sites" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/lodges", label: "Lodges" },
  { href: "/admin/rate-cards", label: "Rate cards" },
  { href: "/admin/box-sizes", label: "Box sizes" },
  { href: "/admin/retail-products", label: "Retail products" },
  { href: "/admin/payment-terminals", label: "Payment terminals" },
  { href: "/admin/species", label: "Species" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/notifications", label: "Notifications" },
  { href: "/admin/subscription", label: "Subscription" },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { supabase, claims, email } = await requireStaff();
  const { data: org } = claims
    ? await supabase.from("org").select("name").eq("id", claims.orgId).maybeSingle()
    : { data: null };

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center gap-6 border-b border-border px-6 py-3">
        <span className="font-semibold">{org?.name ?? "Filletry"}</span>
        <nav className="flex gap-4 text-sm">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="hover:underline">
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="ml-auto text-sm text-muted-foreground">
          {email} {claims ? `· ${claims.appRole}` : null}
        </span>
        <form action={signOut}>
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        {!claims ? (
          <p>
            Your account is not a member of any active organisation yet. Ask a manager to invite
            you, or{" "}
            <Link href="/onboarding" className="underline">
              set up a new plant
            </Link>
            .
          </p>
        ) : !isManager(claims) ? (
          <p>Admin pages are for owners and managers.</p>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
