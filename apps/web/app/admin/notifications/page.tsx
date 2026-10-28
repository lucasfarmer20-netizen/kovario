import { randomUUID } from "node:crypto";
import { ActionForm } from "@/components/admin/action-form";
import { adminPageSession } from "@/lib/auth";
import { notifyReady } from "./actions";

export default async function NotificationsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const { data: intakes, error } = await session.supabase
    .from("intake")
    .select("id,number,state")
    .not("state", "in", "(draft,done,cancelled)")
    .order("intake_at", { ascending: false });
  if (error) return <p>Unable to load intakes.</p>;
  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Customer notifications</h1>
      <p>
        Ready emails are queued automatically on first storage. Send an additional ready notice here
        when needed.
      </p>
      <ActionForm action={notifyReady} actionId={randomUUID()} submitLabel="Send ready notice">
        <label>
          Intake{" "}
          <select required name="intake_id" className="min-h-14 rounded border p-3">
            <option value="">Choose intake</option>
            {intakes?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · {i.state}
              </option>
            ))}
          </select>
        </label>
      </ActionForm>
    </section>
  );
}
