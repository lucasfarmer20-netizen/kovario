import Link from "next/link";
import type { ReactNode } from "react";
import { isManager } from "db";
import { Button } from "@/components/ui/form";
import { requireStaff } from "@/lib/auth";
import { signOut } from "../login/actions";

const NAV = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/devices", label: "Devices" },
  { href: "/admin/sites", label: "Sites" },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { supabase, claims, email } = await requireStaff();
  const { data: org } = claims
    ? await supabase.from("org").select("name").eq("id", claims.orgId).maybeSingle()
    : { data: null };

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center gap-6 border-b border-border px-6 py-3">
        <span className="font-semibold">{org?.name ?? "Kovario"}</span>
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
            you.
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
