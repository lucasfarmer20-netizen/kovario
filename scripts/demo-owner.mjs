// `pnpm db:demo-owner`: creates (or resets) the local demo owner of org `demo-plant`
// through the Auth admin API of the running local Supabase. Local development only.
//   FILLETRY_DEMO_EMAIL     default owner@demo-plant.test
//   FILLETRY_DEMO_PASSWORD  default: a random password, printed once
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000001"; // supabase/seed.sql
const root = join(import.meta.dirname, "..");
const status = JSON.parse(
  execSync("pnpm exec supabase status -o json", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);
if (
  !status.API_URL.startsWith("http://127.0.0.1") &&
  !status.API_URL.startsWith("http://localhost")
) {
  throw new Error("demo-owner only runs against a local Supabase");
}

const email = process.env.FILLETRY_DEMO_EMAIL ?? "owner@demo-plant.test";
const password = process.env.FILLETRY_DEMO_PASSWORD ?? randomBytes(9).toString("base64url");
const headers = {
  apikey: status.SERVICE_ROLE_KEY,
  Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

async function call(path, init) {
  const res = await fetch(`${status.API_URL}${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, json: body ? JSON.parse(body) : null };
}

let userId;
const created = await call("/auth/v1/admin/users", {
  method: "POST",
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (created.ok) {
  userId = created.json.id;
} else {
  const lookup = await call("/rest/v1/rpc/member_lookup_user", {
    method: "POST",
    body: JSON.stringify({ p_email: email }),
  });
  if (!lookup.ok || !lookup.json) throw new Error(`could not create or find ${email}`);
  userId = lookup.json;
  const reset = await call(`/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
  if (!reset.ok) throw new Error(`could not reset the password of ${email}`);
}

const member = await call("/rest/v1/org_member?on_conflict=org_id,user_id", {
  method: "POST",
  headers: { Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify({
    org_id: DEMO_ORG_ID,
    user_id: userId,
    role: "owner",
    display_name: "Demo Owner",
    is_default: true,
  }),
});
if (!member.ok) throw new Error(`could not add ${email} to demo-plant (${member.status})`);

console.log(`Demo owner ready: ${email}`);
if (!process.env.FILLETRY_DEMO_PASSWORD)
  console.log(`Password (local only, not stored): ${password}`);
