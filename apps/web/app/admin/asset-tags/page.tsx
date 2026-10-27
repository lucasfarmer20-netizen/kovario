import { randomUUID } from "node:crypto";
import { adminPageSession } from "@/lib/auth";
import { ActionForm } from "@/components/admin/action-form";
import { manageTags, printTags } from "./actions";
export default async function AssetTagsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [tags, printers] = await Promise.all([
    session.supabase.from("asset_tag").select("*").order("code"),
    session.supabase.from("printer").select("id,name").eq("kind", "label_zpl"),
  ]);
  return (
    <div className="space-y-6">
      <h1>Asset tag pool</h1>
      <ActionForm action={manageTags} actionId={randomUUID()} submitLabel="Create range">
        <label>
          First
          <input name="first" type="number" min="0" max="999" required />
        </label>
        <label>
          Last
          <input name="last" type="number" min="0" max="999" required />
        </label>
      </ActionForm>
      <ActionForm action={printTags} actionId={randomUUID()} submitLabel="Print active tag sheet">
        <select name="printer_id" aria-label="Label printer" required>
          {printers.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </ActionForm>
      {tags.error && <p role="alert">Unable to load tags</p>}
      <ul>
        {tags.data?.map((t) => (
          <li key={t.id} className="border-b py-3">
            <strong>{t.code}</strong> · {t.state}
            {t.state !== "in_use" && (
              <ActionForm
                action={manageTags}
                actionId={randomUUID()}
                submitLabel={t.state === "retired" ? "Reactivate" : "Retire"}
              >
                <input type="hidden" name="tag_id" value={t.id} />
                {t.state === "retired" ? (
                  <input type="hidden" name="reactivate" value="yes" />
                ) : (
                  <input
                    name="reason"
                    aria-label={`Retire ${t.code} reason`}
                    placeholder="Retirement reason"
                    required
                  />
                )}
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
