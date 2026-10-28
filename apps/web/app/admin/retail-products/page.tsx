import { randomUUID } from "node:crypto";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { saveRetailProduct } from "./actions";

function ProductFields({
  name = "",
  sku = "",
  unitPrice = null,
  isActive = true,
}: {
  name?: string;
  sku?: string | null;
  unitPrice?: number | null;
  isActive?: boolean;
}) {
  return (
    <>
      <Label>
        Name
        <Input name="name" defaultValue={name} required maxLength={80} />
      </Label>
      <Label>
        SKU
        <Input name="sku" defaultValue={sku ?? ""} maxLength={40} className="w-32" />
      </Label>
      <Label>
        Price $
        <Input
          name="unit_price"
          type="number"
          min={0}
          step="0.01"
          defaultValue={unitPrice ?? ""}
          required
          className="w-28"
        />
      </Label>
      <Label>
        Active
        <input name="is_active" type="checkbox" defaultChecked={isActive} />
      </Label>
    </>
  );
}

export default async function RetailProductsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const { data: products, error } = await session.supabase
    .from("retail_product")
    .select("id, name, sku, unit_price, is_active")
    .order("name");

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Retail products</h1>
        <p className="text-sm text-muted-foreground">
          The register&apos;s retail catalogue (ice packs, bags, smoked product). The cashier adds
          these to a cart next to the customer&apos;s outstanding items; they are taxed with the
          rest of the cart. Uncheck Active to stop selling a product.
        </p>
        <ActionForm action={saveRetailProduct} actionId={randomUUID()} submitLabel="Add product">
          <ProductFields />
        </ActionForm>
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}

      <ul className="flex flex-col divide-y divide-border">
        {(products ?? []).map((p) => (
          <li key={p.id} className="py-3">
            <ActionForm action={saveRetailProduct} actionId={randomUUID()} submitLabel="Save">
              <input type="hidden" name="retail_product_id" value={p.id} />
              <ProductFields
                name={p.name}
                sku={p.sku}
                unitPrice={p.unit_price}
                isActive={p.is_active}
              />
            </ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
