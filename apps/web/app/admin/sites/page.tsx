import { randomUUID } from "node:crypto";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { createSite, makeDefaultSite, renameSite } from "./actions";

export default async function SitesPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const { data: sites, error } = await session.supabase
    .from("site")
    .select("id, name, is_default")
    .order("name");

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Sites</h1>
        <p className="text-sm text-muted-foreground">
          Physical locations of this plant (e.g. Main, Lodge). Devices and printers are routed per
          site.
        </p>
        <ActionForm action={createSite} actionId={randomUUID()} submitLabel="Add site">
          <Label>
            Name
            <Input name="name" required maxLength={80} />
          </Label>
        </ActionForm>
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}

      <ul className="flex flex-col divide-y divide-border">
        {(sites ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-start gap-6 py-3">
            <ActionForm action={renameSite} actionId={randomUUID()} submitLabel="Rename">
              <input type="hidden" name="site_id" value={s.id} />
              <Input
                name="name"
                defaultValue={s.name}
                required
                maxLength={80}
                aria-label="Site name"
              />
            </ActionForm>
            {s.is_default ? (
              <span className="py-2 text-sm text-muted-foreground">Default site</span>
            ) : (
              <ActionForm
                action={makeDefaultSite}
                actionId={randomUUID()}
                submitLabel="Make default"
              >
                <input type="hidden" name="site_id" value={s.id} />
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
