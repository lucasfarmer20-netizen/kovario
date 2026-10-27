import { randomUUID } from "node:crypto";
import { setRateLines } from "@/app/admin/rate-cards/actions";
import { ActionForm } from "@/components/admin/action-form";
import { Input } from "@/components/ui/form";
import { RATE_FIELD_PREFIX, orderRateLines } from "@/lib/rate-card";

/** Editable amounts of one rate card (all its lines in one idempotent save). */
export function RateLinesForm({
  cardId,
  lines,
  methods,
  submitLabel = "Save rates",
}: {
  cardId: string;
  lines: { key: string; amount: number }[];
  methods: { code: string; name: string; sort: number }[];
  submitLabel?: string;
}) {
  return (
    <ActionForm
      action={setRateLines}
      actionId={randomUUID()}
      submitLabel={submitLabel}
      className="flex-col items-start"
    >
      <input type="hidden" name="rate_card_id" value={cardId} />
      <table className="text-sm">
        <tbody>
          {orderRateLines(lines, methods).map((l) => (
            <tr key={l.key}>
              <td className="py-1 pr-4">{l.label}</td>
              <td className="py-1">
                <span className="mr-1 text-muted-foreground">$</span>
                <Input
                  name={`${RATE_FIELD_PREFIX}${l.key}`}
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={Number(l.amount).toFixed(2)}
                  aria-label={l.label}
                  className="w-28"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ActionForm>
  );
}
