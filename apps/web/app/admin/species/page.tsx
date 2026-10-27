import { randomUUID } from "node:crypto";
import { ActionForm } from "@/components/admin/action-form";
import { Input } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { seedReference, updateMethod, updateSpecies } from "./actions";

export default async function SpeciesPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [{ data: species, error }, { data: methods }, { count: yields }] = await Promise.all([
    session.supabase
      .from("species")
      .select("id, code, name, group, shorthand, sort, is_active")
      .order("sort"),
    session.supabase
      .from("processing_method")
      .select("id, code, name, kind, is_exchange, lodge_cappable, is_active")
      .order("sort"),
    session.supabase.from("yield_factor").select("id", { count: "exact", head: true }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Species &amp; methods</h1>
        <p className="text-sm text-muted-foreground">
          Seeded from the processing rules ({species?.length ?? 0} species, {yields ?? 0} yield
          factors). Inactive species and methods disappear from intake. Shorthand prints on tote
          tags.
        </p>
        <ActionForm
          action={seedReference}
          actionId={randomUUID()}
          submitLabel="Add missing processing rules"
        />
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Species</h2>
        <ul className="flex flex-col divide-y divide-border">
          {(species ?? []).map((s) => (
            <li key={s.id} className="py-2">
              <ActionForm action={updateSpecies} actionId={randomUUID()} submitLabel="Save">
                <input type="hidden" name="species_id" value={s.id} />
                <span className="w-24 text-xs text-muted-foreground">{s.group}</span>
                <Input
                  name="name"
                  defaultValue={s.name}
                  required
                  maxLength={80}
                  aria-label="Name"
                />
                <Input
                  name="shorthand"
                  defaultValue={s.shorthand ?? ""}
                  maxLength={6}
                  aria-label="Shorthand"
                  className="w-24 uppercase"
                />
                <Input
                  name="sort"
                  type="number"
                  min={0}
                  defaultValue={s.sort}
                  aria-label="Sort"
                  className="w-20"
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="is_active"
                    defaultChecked={s.is_active}
                    className="size-5"
                  />
                  Active
                </label>
              </ActionForm>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Processing methods</h2>
        <p className="text-sm text-muted-foreground">
          The lodge price cap only applies to cappable methods. Fresh is split into fillets and
          portions, so it has no rate of its own.
        </p>
        <ul className="flex flex-col divide-y divide-border">
          {(methods ?? []).map((m) => (
            <li key={m.id} className="py-2">
              <ActionForm action={updateMethod} actionId={randomUUID()} submitLabel="Save">
                <input type="hidden" name="method_id" value={m.id} />
                <span className="w-24 text-xs text-muted-foreground">
                  {m.kind === "virtual" ? "split" : m.is_exchange ? "exchange" : "service"}
                </span>
                <Input
                  name="name"
                  defaultValue={m.name}
                  required
                  maxLength={80}
                  aria-label="Name"
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="is_active"
                    defaultChecked={m.is_active}
                    className="size-5"
                  />
                  Active
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="lodge_cappable"
                    defaultChecked={m.lodge_cappable}
                    className="size-5"
                  />
                  Lodge cap applies
                </label>
              </ActionForm>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
