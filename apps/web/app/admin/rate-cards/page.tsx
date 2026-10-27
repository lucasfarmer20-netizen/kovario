import { randomUUID } from "node:crypto";
import { ActionForm } from "@/components/admin/action-form";
import { RateLinesForm } from "@/components/admin/rate-lines-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { createRateCard, deleteRateCard, updateRateCard } from "./actions";

export default async function RateCardsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [{ data: cards, error }, { data: methods }] = await Promise.all([
    session.supabase
      .from("rate_card")
      .select("id, name, starts_on, ends_on, is_default, rate_card_line(key, amount)")
      .order("is_default", { ascending: false })
      .order("starts_on", { ascending: false }),
    session.supabase.from("processing_method").select("code, name, sort"),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Rate cards</h1>
        <p className="text-sm text-muted-foreground">
          The only source of prices. A season card applies between its dates (one card per date);
          the default card applies whenever no season card does. Intakes keep the card they were
          priced with, so a used card is end-dated rather than deleted.
        </p>
        <ActionForm action={createRateCard} actionId={randomUUID()} submitLabel="Add season card">
          <Label>
            Name
            <Input name="name" required maxLength={80} placeholder="Summer 2027" />
          </Label>
          <Label>
            Starts
            <Input name="starts_on" type="date" required />
          </Label>
          <Label>
            Ends (optional)
            <Input name="ends_on" type="date" />
          </Label>
          <Label>
            Copy rates from
            <Select name="copy_from" defaultValue="">
              <option value="">Default card</option>
              {(cards ?? [])
                .filter((c) => !c.is_default)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Label>
        </ActionForm>
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}
      {cards && cards.length === 0 ? (
        <p className="text-sm">
          No rate cards yet. Add the processing rules on the Species page; that also creates the
          default card.
        </p>
      ) : null}

      {(cards ?? []).map((card) => {
        const zero = card.rate_card_line.filter((l) => Number(l.amount) === 0).length;
        return (
          <section key={card.id} className="flex flex-col gap-3 border-t border-border pt-4">
            <h2 className="font-semibold">
              {card.name}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {card.is_default
                  ? "· default"
                  : `· ${card.starts_on} → ${card.ends_on ?? "open-ended"}`}
              </span>
            </h2>
            {zero > 0 ? (
              <p role="status" className="text-sm text-destructive">
                {zero} rate{zero === 1 ? " is" : "s are"} $0.00 — those items will be free.
              </p>
            ) : null}
            <ActionForm action={updateRateCard} actionId={randomUUID()} submitLabel="Save">
              <input type="hidden" name="rate_card_id" value={card.id} />
              <Label>
                Name
                <Input name="name" defaultValue={card.name} required maxLength={80} />
              </Label>
              {card.is_default ? (
                <>
                  <input type="hidden" name="starts_on" value="" />
                  <input type="hidden" name="ends_on" value="" />
                </>
              ) : (
                <>
                  <Label>
                    Starts
                    <Input
                      name="starts_on"
                      type="date"
                      defaultValue={card.starts_on ?? ""}
                      required
                    />
                  </Label>
                  <Label>
                    Ends
                    <Input name="ends_on" type="date" defaultValue={card.ends_on ?? ""} />
                  </Label>
                </>
              )}
            </ActionForm>
            <RateLinesForm cardId={card.id} lines={card.rate_card_line} methods={methods ?? []} />
            {card.is_default ? null : (
              <ActionForm action={deleteRateCard} actionId={randomUUID()} submitLabel="Delete card">
                <input type="hidden" name="rate_card_id" value={card.id} />
              </ActionForm>
            )}
          </section>
        );
      })}
    </div>
  );
}
