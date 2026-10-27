import { randomUUID } from "node:crypto";
import Link from "next/link";
import { adminPageSession } from "@/lib/auth";
import { fetchAllPages } from "@/lib/locations";
import { ActionForm } from "@/components/admin/action-form";
import { addPallet, generateLocations, printLocationTags, setArchived } from "./actions";

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ zone?: string }>;
}) {
  const session = await adminPageSession();
  if (!session) return null;
  const { zone: zoneParam } = await searchParams;
  const { supabase } = session;
  // Every read pages past the PostgREST row cap: one generator run can exceed it.
  const zoneRows = await fetchAllPages((from, to) =>
    supabase.from("location").select("zone,id").order("zone").order("id").range(from, to),
  ).catch(() => null);
  const zoneList = [...new Set((zoneRows ?? []).map((z) => z.zone))];
  const zone = zoneParam && zoneList.includes(zoneParam) ? zoneParam : zoneList[0];
  const [locationRows, printers] = await Promise.all([
    zone
      ? fetchAllPages((from, to) =>
          supabase
            .from("location")
            .select("id,code,kind,is_active,capacity")
            .eq("zone", zone)
            .order("sort_key")
            .order("id")
            .range(from, to),
        ).catch(() => null)
      : [],
    supabase.from("printer").select("id,name").eq("kind", "label_zpl"),
  ]);
  const loadError = zoneRows === null || locationRows === null;
  const locations = locationRows ?? [];
  return (
    <div className="space-y-6">
      <h1>Freezer locations</h1>
      <p className="text-sm text-muted-foreground">
        Generate only the racking actually built. Re-running the generator adds missing positions
        and leaves existing ones (including archived ones) untouched. Capacity is display-only and
        never blocks a placement.
      </p>
      <ActionForm action={generateLocations} actionId={randomUUID()} submitLabel="Generate">
        <label>
          Zone
          <input name="zone" placeholder="IF" required maxLength={8} />
        </label>
        <label>
          Rows (one per line: row bays levels)
          <textarea name="rows" rows={4} placeholder={"A 12 4\nB 10 4"} required />
        </label>
        <label>
          <input type="checkbox" name="depth_F" defaultChecked /> Front (F)
        </label>
        <label>
          <input type="checkbox" name="depth_R" defaultChecked /> Rear (R)
        </label>
      </ActionForm>
      <ActionForm action={addPallet} actionId={randomUUID()} submitLabel="Add pallet / quarantine">
        <label>
          Zone
          <input name="zone" placeholder="IF" required maxLength={8} />
        </label>
      </ActionForm>
      {zone && (
        <ActionForm
          action={printLocationTags}
          actionId={randomUUID()}
          submitLabel={`Print ${zone} tag sheet`}
        >
          <input type="hidden" name="zone" value={zone} />
          <select name="printer_id" aria-label="Label printer" required>
            {printers.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </ActionForm>
      )}
      <nav className="flex gap-3" aria-label="Zones">
        {zoneList.map((z) => (
          <Link
            key={z}
            href={`/admin/locations?zone=${encodeURIComponent(z)}`}
            className={z === zone ? "font-semibold underline" : "hover:underline"}
          >
            {z}
          </Link>
        ))}
      </nav>
      {loadError && <p role="alert">Unable to load locations</p>}
      {!zone && <p>No locations yet. Generate the first rack above.</p>}
      <ul>
        {locations.map((l) => (
          <li key={l.id} className="flex items-center gap-4 border-b py-2">
            <strong className={l.is_active ? "" : "line-through"}>{l.code}</strong>
            <span>
              {l.kind}
              {l.capacity != null && ` · capacity ${l.capacity}`}
              {!l.is_active && " · archived"}
            </span>
            <ActionForm
              action={setArchived}
              actionId={randomUUID()}
              submitLabel={l.is_active ? "Archive" : "Unarchive"}
            >
              <input type="hidden" name="location_id" value={l.id} />
              {l.is_active && <input type="hidden" name="archive" value="yes" />}
            </ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
