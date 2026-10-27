import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPhone } from "rules";
import { z } from "zod";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { mergeCustomers, setLodgeGuest, updateCustomer } from "../actions";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await adminPageSession();
  if (!session) return null;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();

  const { data: customer, error } = await session.supabase
    .from("customer")
    .select("id, name, phone, email, notes, is_lodge_guest, lodge_id, last_visit_at, created_at")
    .eq("id", id.data)
    .maybeSingle();
  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!customer) notFound();

  const [{ data: lodges }, { data: samePhone }] = await Promise.all([
    session.supabase.from("lodge").select("id, name, pricing_cap").order("name"),
    customer.phone
      ? session.supabase
          .from("customer")
          .select("id, name, email, is_lodge_guest, lodge_id, created_at")
          .eq("phone", customer.phone)
          .neq("id", customer.id)
          .order("created_at")
      : Promise.resolve({ data: [] }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <Link href="/admin/customers" className="text-sm text-muted-foreground hover:underline">
          ← Customers
        </Link>
        <h1 className="text-xl font-semibold">{customer.name}</h1>
        <p className="text-sm text-muted-foreground">
          {customer.phone ? formatPhone(customer.phone) : "No phone"} ·{" "}
          {customer.last_visit_at
            ? `last visit ${new Date(customer.last_visit_at).toLocaleDateString()}`
            : "no visits yet"}
        </p>
        <ActionForm
          action={updateCustomer}
          actionId={randomUUID()}
          submitLabel="Save"
          className="flex-col items-start"
        >
          <input type="hidden" name="customer_id" value={customer.id} />
          <Label>
            Name
            <Input name="name" defaultValue={customer.name} required maxLength={120} />
          </Label>
          <Label>
            Phone
            <Input
              name="phone"
              inputMode="tel"
              defaultValue={customer.phone ? formatPhone(customer.phone) : ""}
              maxLength={30}
            />
          </Label>
          <Label>
            Email
            <Input name="email" type="email" defaultValue={customer.email ?? ""} />
          </Label>
          <Label>
            Notes
            <textarea
              name="notes"
              defaultValue={customer.notes ?? ""}
              maxLength={2000}
              rows={3}
              className="w-96 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Label>
        </ActionForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Lodge guest</h2>
        <p className="text-sm text-muted-foreground">
          Lodge guests pay at most the lodge&apos;s per-lb cap on cappable methods. Changing this
          reprices the customer&apos;s open, unpaid, non-Fast-Pass processing charges.
        </p>
        {(lodges ?? []).length === 0 ? (
          <p className="text-sm">
            No lodges yet — <Link href="/admin/lodges">add one</Link> first.
          </p>
        ) : (
          <ActionForm action={setLodgeGuest} actionId={randomUUID()} submitLabel="Apply">
            <input type="hidden" name="customer_id" value={customer.id} />
            <Select
              name="lodge"
              aria-label="Lodge"
              defaultValue={
                customer.is_lodge_guest && customer.lodge_id ? customer.lodge_id : "none"
              }
            >
              <option value="none">Not a lodge guest</option>
              {(lodges ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.pricing_cap !== null ? ` (cap $${l.pricing_cap}/lb)` : " (no cap)"}
                </option>
              ))}
            </Select>
          </ActionForm>
        )}
      </section>

      {samePhone && samePhone.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Same phone</h2>
          <p className="text-sm text-muted-foreground">
            Merging moves the other customer&apos;s intakes, charges and payments here and deletes
            it. Both must have the same lodge status.
          </p>
          <ul className="flex flex-col divide-y divide-border">
            {samePhone.map((other) => (
              <li key={other.id} className="flex flex-wrap items-center gap-4 py-2">
                <Link href={`/admin/customers/${other.id}`} className="hover:underline">
                  {other.name}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {other.email ?? "no email"}
                  {other.is_lodge_guest ? " · lodge guest" : ""}
                </span>
                <ActionForm
                  action={mergeCustomers}
                  actionId={randomUUID()}
                  submitLabel={`Merge ${other.name} into this customer`}
                >
                  <input type="hidden" name="keep_id" value={customer.id} />
                  <input type="hidden" name="merge_id" value={other.id} />
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
