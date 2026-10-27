import { randomUUID } from "node:crypto";
import { agentOnline } from "db";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { createAgent, pairAgent } from "./actions";
export default async function AgentsPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [agents, sites] = await Promise.all([
    session.supabase.from("print_agent").select("id,name,site_id,last_seen_at").order("name"),
    session.supabase.from("site").select("id,name").order("name"),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Print agents</h1>
      <p>
        Agents are offline after 90 seconds without a heartbeat. Refresh to update status. Pairing
        codes expire after 10 minutes.
      </p>
      {agents.error || sites.error ? <p role="alert">Could not load agents or sites.</p> : null}
      <ActionForm action={createAgent} actionId={randomUUID()} submitLabel="Add agent">
        <Label>
          Name
          <Input name="name" required maxLength={80} />
        </Label>
        <Label>
          Site
          <Select name="site_id">
            <option value="">No site</option>
            {sites.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Label>
      </ActionForm>
      <ul className="divide-y">
        {agents.data?.map((a) => (
          <li key={a.id} className="py-4">
            <h2 className="font-semibold">
              {a.name} � {agentOnline(a.last_seen_at) ? "Online" : "Offline"}
            </h2>
            <p>
              Last seen: {a.last_seen_at ?? "Never"} �{" "}
              {sites.data?.find((s) => s.id === a.site_id)?.name ?? "No site"}
            </p>
            <ActionForm action={pairAgent} actionId={randomUUID()} submitLabel="New pairing code">
              <input type="hidden" name="agent_id" value={a.id} />
            </ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
