import { randomUUID } from "node:crypto";
import { Constants, type Enums } from "db";
import { ActionForm } from "@/components/admin/action-form";
import { Input, Label, Select } from "@/components/ui/form";
import { adminPageSession } from "@/lib/auth";
import { inviteMember, setMemberPin, setMemberRole } from "./actions";

const ROLES: readonly Enums<"org_member_role">[] = Constants.public.Enums.org_member_role;

export default async function UsersPage() {
  const session = await adminPageSession();
  if (!session) return null;
  const { data: members, error } = await session.supabase.rpc("admin_list_members");
  const roles = session.claims.appRole === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Users</h1>
        <ActionForm action={inviteMember} actionId={randomUUID()} submitLabel="Send invite">
          <Label>
            Email
            <Input type="email" name="email" required />
          </Label>
          <Label>
            Name
            <Input name="display_name" required maxLength={80} />
          </Label>
          <Label>
            Role
            <Select name="role" defaultValue="staff">
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Label>
        </ActionForm>
      </section>

      {error ? <p className="text-destructive">{error.message}</p> : null}

      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th className="py-2">Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Operator PIN</th>
          </tr>
        </thead>
        <tbody>
          {(members ?? []).map((m) => (
            <tr key={m.id} className="border-b border-border align-top">
              <td className="py-3 font-medium">{m.display_name}</td>
              <td className="py-3">{m.email}</td>
              <td className="py-3">
                <ActionForm action={setMemberRole} actionId={randomUUID()} submitLabel="Save">
                  <input type="hidden" name="member_id" value={m.id} />
                  <Select
                    name="role"
                    defaultValue={m.role}
                    aria-label={`Role for ${m.display_name}`}
                  >
                    {(roles.includes(m.role) ? roles : [m.role, ...roles]).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </ActionForm>
              </td>
              <td className="py-3">
                <ActionForm
                  action={setMemberPin}
                  actionId={randomUUID()}
                  submitLabel={m.has_pin ? "Change" : "Set"}
                >
                  <input type="hidden" name="member_id" value={m.id} />
                  <Input
                    name="pin"
                    type="password"
                    inputMode="numeric"
                    pattern="\d{4,6}"
                    autoComplete="off"
                    placeholder={m.has_pin ? "••••" : "4–6 digits"}
                    aria-label={`PIN for ${m.display_name}`}
                    className="w-28"
                    required
                  />
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
