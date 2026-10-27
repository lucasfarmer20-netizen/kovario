import { randomUUID } from "node:crypto";
import { formatPhone } from "rules";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { createLodge, updateLodge } from "./actions";

type Contact = { name?: string; phone?: string; email?: string };

function LodgeFields({
  name = "",
  cap = null,
  contact = {},
}: {
  name?: string;
  cap?: number | null;
  contact?: Contact;
}) {
  return (
    <>
      <Label>
        Name
        <Input name="name" defaultValue={name} required maxLength={80} />
      </Label>
      <Label>
        Cap $/lb
        <Input
          name="pricing_cap"
          type="number"
          min={0}
          step="0.01"
          defaultValue={cap ?? ""}
          placeholder="no cap"
          className="w-28"
        />
      </Label>
      <Label>
        Contact
        <Input name="contact_name" defaultValue={contact.name ?? ""} maxLength={80} />
      </Label>
      <Label>
        Contact phone
        <Input
          name="contact_phone"
          inputMode="tel"
          defaultValue={contact.phone ? formatPhone(contact.phone) : ""}
          maxLength={30}
        />
      </Label>
      <Label>
        Contact email
        <Input name="contact_email" type="email" defaultValue={contact.email ?? ""} />
      </Label>
    </>
  );
}

export default async function LodgesPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const { data: lodges, error } = await session.supabase
    .from("lodge")
    .select("id, name, pricing_cap, contact")
    .order("name");

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Lodges</h1>
        <p className="text-sm text-muted-foreground">
          A lodge&apos;s guests pay at most its per-lb cap on cappable processing methods (never
          ribbing; Fast Pass overrides the cap). Mark guests on the customer page.
        </p>
        <ActionForm action={createLodge} actionId={randomUUID()} submitLabel="Add lodge">
          <LodgeFields />
        </ActionForm>
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}

      <ul className="flex flex-col divide-y divide-border">
        {(lodges ?? []).map((l) => (
          <li key={l.id} className="py-3">
            <ActionForm action={updateLodge} actionId={randomUUID()} submitLabel="Save">
              <input type="hidden" name="lodge_id" value={l.id} />
              <LodgeFields name={l.name} cap={l.pricing_cap} contact={l.contact as Contact} />
            </ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
