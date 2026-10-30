import { randomUUID } from "node:crypto";
import Link from "next/link";
import { MAX_TAG_RANGE, maxTagNumber } from "rules";
import { tagListPage } from "@/lib/asset-tags";
import { adminPageSession } from "@/lib/auth";
import { ActionForm } from "@/components/admin/action-form";
import type { OrgSettings } from "@/lib/org-settings";
import { manageTags, printTags } from "./actions";
export default async function AssetTagsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await adminPageSession();
  if (!session) return null;
  const { supabase } = session;
  const [count, printers, org] = await Promise.all([
    supabase.from("asset_tag").select("id", { count: "exact", head: true }),
    supabase.from("printer").select("id,name").eq("kind", "label_zpl"),
    supabase.from("org").select("settings").maybeSingle(),
  ]);
  const digits = (org.data?.settings as OrgSettings | undefined)?.scanner.tag_digits;
  if (!digits) return <p role="alert">Unable to load the organisation</p>;
  const max = maxTagNumber(digits);
  // The pool can exceed the PostgREST row cap: list it a page at a time.
  const total = count.count ?? 0;
  const list = tagListPage((await searchParams).page, total);
  const tags = await supabase.from("asset_tag").select("*").order("code").range(list.from, list.to);
  return (
    <div className="space-y-6">
      <h1>Asset tag pool</h1>
      <p>
        {digits}-digit tags (0–{max}), up to {MAX_TAG_RANGE.toLocaleString("en-US")} per range.
        Raise the width in Settings → Asset tag digits.
      </p>
      <ActionForm action={manageTags} actionId={randomUUID()} submitLabel="Create range">
        <label>
          First
          <input name="first" type="number" min="0" max={max} required />
        </label>
        <label>
          Last
          <input name="last" type="number" min="0" max={max} required />
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
      {(count.error || tags.error) && <p role="alert">Unable to load tags</p>}
      {total > 0 && (
        <nav aria-label="Tag pages" className="flex gap-4">
          <span>
            Tags {list.from + 1}–{Math.min(list.to + 1, total)} of {total}
          </span>
          {list.page > 1 && <Link href={`?page=${list.page - 1}`}>Previous</Link>}
          {list.page < list.pages && <Link href={`?page=${list.page + 1}`}>Next</Link>}
        </nav>
      )}
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
