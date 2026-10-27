import { randomUUID } from "node:crypto";
import Link from "next/link";
import { formatPhone } from "rules";
import { ActionForm } from "@/components/admin/action-form";
import { Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { mergeCustomers } from "./actions";
import { CustomerFinder } from "./customer-finder";

type DuplicateMember = {
  id: string;
  name: string;
  email: string | null;
  last_visit_at: string | null;
  is_lodge_guest: boolean;
  intake_count: number;
};

const RECENT = 50;

export default async function CustomersPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [{ data: recent, error }, { data: duplicates }] = await Promise.all([
    session.supabase
      .from("customer")
      .select("id, name, phone, email, last_visit_at, is_lodge_guest, lodge(name)")
      .order("updated_at", { ascending: false })
      .limit(RECENT),
    session.supabase.rpc("admin_customer_duplicates"),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Customers</h1>
        <p className="text-sm text-muted-foreground">
          Search by phone (3+ digits, any format) or name; pick a customer to edit, or create one
          from the last option.
        </p>
        <CustomerFinder />
      </section>

      {duplicates && duplicates.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Possible duplicates</h2>
          <p className="text-sm text-muted-foreground">
            Customers sharing a phone number. Merging moves every intake, charge and payment to the
            customer you keep and deletes the other. Households sometimes share a phone — only merge
            the same person.
          </p>
          <ul className="flex flex-col divide-y divide-border">
            {duplicates.map((group) => {
              const members = group.customers as unknown as DuplicateMember[];
              // Default: keep the customer with the most intakes.
              const keep = [...members].sort((a, b) => b.intake_count - a.intake_count)[0];
              const merge = members.find((m) => m.id !== keep?.id);
              return (
                <li key={group.phone} className="flex flex-col gap-2 py-3">
                  <span className="font-medium tabular-nums">{formatPhone(group.phone)}</span>
                  <ul className="text-sm">
                    {members.map((m) => (
                      <li key={m.id}>
                        <Link href={`/admin/customers/${m.id}`} className="hover:underline">
                          {m.name}
                        </Link>{" "}
                        <span className="text-muted-foreground">
                          · {m.intake_count} intake{m.intake_count === 1 ? "" : "s"}
                          {m.email ? ` · ${m.email}` : ""}
                          {m.is_lodge_guest ? " · lodge guest" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <ActionForm action={mergeCustomers} actionId={randomUUID()} submitLabel="Merge">
                    <Label>
                      Keep
                      <Select name="keep_id" defaultValue={keep?.id}>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </Label>
                    <Label>
                      Merge into it (deleted)
                      <Select name="merge_id" defaultValue={merge?.id}>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </Label>
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recently updated</h2>
        {error ? <p className="text-destructive">{error.message}</p> : null}
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Phone</th>
              <th className="py-2 font-medium">Email</th>
              <th className="py-2 font-medium">Lodge</th>
              <th className="py-2 font-medium">Last visit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(recent ?? []).map((c) => (
              <tr key={c.id}>
                <td className="py-2">
                  <Link href={`/admin/customers/${c.id}`} className="hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td className="py-2 tabular-nums">{c.phone ? formatPhone(c.phone) : "—"}</td>
                <td className="py-2">{c.email ?? "—"}</td>
                <td className="py-2">
                  {c.is_lodge_guest ? (c.lodge?.name ?? "Lodge guest") : "—"}
                </td>
                <td className="py-2">
                  {c.last_visit_at ? new Date(c.last_visit_at).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
