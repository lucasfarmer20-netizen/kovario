import { randomUUID } from "node:crypto";
import { agentOnline } from "db";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { savePrinter, testPrint } from "./actions";
export default async function PrintersPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const [printers, agents, sites, jobs] = await Promise.all([
    session.supabase.from("printer").select("id,name,kind,address,agent_id,site_id").order("name"),
    session.supabase.from("print_agent").select("id,name,last_seen_at,site_id"),
    session.supabase.from("site").select("id,name"),
    session.supabase
      .from("print_job")
      .select("id,printer_id,state,error,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
  ]);
  function fields(p?: NonNullable<typeof printers.data>[number]) {
    return (
      <>
        <input type="hidden" name="printer_id" value={p?.id ?? ""} />
        <Label>
          Name
          <Input name="name" required defaultValue={p?.name} />
        </Label>
        <Label>
          Site
          <Select name="site_id" defaultValue={p?.site_id ?? ""}>
            <option value="">No site</option>
            {sites.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Agent
          <Select name="agent_id" required defaultValue={p?.agent_id ?? ""}>
            <option value="">Select agent</option>
            {agents.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Kind
          <Select name="kind" defaultValue={p?.kind ?? "label_zpl"}>
            <option value="label_zpl">ZPL label</option>
            <option value="receipt_pdf">PDF receipt</option>
          </Select>
        </Label>
        <Label>
          TCP host:port or OS printer name
          <Input name="address" required defaultValue={p?.address ?? ""} />
        </Label>
      </>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Printers</h1>
      <p>
        Assign each printer to the agent at its site. ZPL goes directly to TCP 9100; PDFs use an OS
        queue.
      </p>
      {[printers, agents, sites, jobs].some((r) => r.error) ? (
        <p role="alert">Could not load printing configuration.</p>
      ) : null}
      <ActionForm action={savePrinter} actionId={randomUUID()} submitLabel="Add printer">
        {fields()}
      </ActionForm>
      {printers.data?.map((p) => (
        <section key={p.id} className="border-t py-4">
          <h2>
            {p.name} �{" "}
            {agentOnline(agents.data?.find((a) => a.id === p.agent_id)?.last_seen_at ?? null)
              ? "Online"
              : "Offline"}
          </h2>
          <ActionForm action={savePrinter} actionId={randomUUID()} submitLabel="Save">
            {fields(p)}
          </ActionForm>
          <ActionForm action={testPrint} actionId={randomUUID()} submitLabel="Test print">
            <input type="hidden" name="printer_id" value={p.id} />
            {p.kind === "receipt_pdf" ? (
              <Label>
                Signed HTTPS PDF URL
                <Input type="url" name="pdf_url" required />
              </Label>
            ) : null}
          </ActionForm>
        </section>
      ))}
      <h2 className="font-semibold">Recent jobs</h2>
      <ul>
        {jobs.data?.map((j) => (
          <li key={j.id}>
            {printers.data?.find((p) => p.id === j.printer_id)?.name} � {j.state} � {j.created_at}
            {j.error ? ` � ${j.error}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
