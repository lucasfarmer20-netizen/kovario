import { randomUUID } from "node:crypto";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { saveBoxSize } from "./actions";

type Dims = {
  length_in?: number;
  width_in?: number;
  height_in?: number;
  packaging_lb?: number;
  dry_ice_lb?: number;
};

function SizeFields({
  name = "",
  maxLb = null,
  fee = null,
  dims = {},
  isActive = true,
}: {
  name?: string;
  maxLb?: number | null;
  fee?: number | null;
  dims?: Dims;
  isActive?: boolean;
}) {
  return (
    <>
      <Label>
        Name
        <Input name="name" defaultValue={name} required maxLength={60} />
      </Label>
      <Label>
        Max lb
        <Input
          name="max_lb"
          type="number"
          min={0.01}
          step="0.01"
          defaultValue={maxLb ?? ""}
          required
          className="w-24"
        />
      </Label>
      <Label>
        Fee $
        <Input
          name="fee"
          type="number"
          min={0}
          step="0.01"
          defaultValue={fee ?? ""}
          required
          className="w-24"
        />
      </Label>
      {(["length_in", "width_in", "height_in"] as const).map((k) => (
        <Label key={k}>
          {k === "length_in" ? "L in" : k === "width_in" ? "W in" : "H in"}
          <Input
            name={k}
            type="number"
            min={0.1}
            step="0.1"
            defaultValue={dims[k] ?? ""}
            className="w-20"
          />
        </Label>
      ))}
      {(["packaging_lb", "dry_ice_lb"] as const).map((k) => (
        <Label key={k}>
          {k === "packaging_lb" ? "Packaging lb" : "Dry ice lb"}
          <Input
            name={k}
            type="number"
            min={0}
            step="0.1"
            defaultValue={dims[k] ?? ""}
            className="w-20"
          />
        </Label>
      ))}
      <Label>
        Active
        <input name="is_active" type="checkbox" defaultChecked={isActive} />
      </Label>
    </>
  );
}

export default async function BoxSizesPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const { data: sizes, error } = await session.supabase
    .from("box_size")
    .select("id, name, max_lb, fee, dims, is_active")
    .order("max_lb");

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Box sizes</h1>
        <p className="text-sm text-muted-foreground">
          The catalogue the counter plans boxes from. Each planned box adds its size&apos;s fee to
          the angler&apos;s settlement. Boxes over 70 lb need the heavy check at the counter.
          Uncheck Active to retire a size; boxes already planned with it keep it. Shipping quotes a
          box at its weight plus the size&apos;s packaging and dry ice lb, with L×W×H as the parcel.
        </p>
        <ActionForm action={saveBoxSize} actionId={randomUUID()} submitLabel="Add box size">
          <SizeFields />
        </ActionForm>
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}

      <ul className="flex flex-col divide-y divide-border">
        {(sizes ?? []).map((s) => (
          <li key={s.id} className="py-3">
            <ActionForm action={saveBoxSize} actionId={randomUUID()} submitLabel="Save">
              <input type="hidden" name="box_size_id" value={s.id} />
              <SizeFields
                name={s.name}
                maxLb={s.max_lb}
                fee={s.fee}
                dims={s.dims as Dims}
                isActive={s.is_active}
              />
            </ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
