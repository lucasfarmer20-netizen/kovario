// `pnpm db:preview-demo`: creates or refreshes the throwaway demo org that Vercel preview
// deployments sign in to on **staging** (docs/01-ARCHITECTURE.md §8, docs/11-DEPLOY.md §4).
// Idempotent: upserts org `preview-demo`, its sites, the demo owner (password reset to the
// given one) and the owner membership. Never run it against prod; hosted deploys never seed.
//   STAGING_SUPABASE_URL               https://<staging-ref>.supabase.co
//   STAGING_SUPABASE_SERVICE_ROLE_KEY  staging service-role key (never commit it)
//   FILLETRY_PREVIEW_DEMO_PASSWORD     password for the demo owner
//   FILLETRY_PREVIEW_DEMO_EMAIL        default owner@preview-demo.test
//   SUPABASE_PROD_PROJECT_REF          optional; when set, a URL on that project is refused
const DEMO_ORG_ID = "00000000-0000-4000-8000-0000000000de";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`preview-demo-org: set ${name}`);
  return value;
}

const url = new URL(required("STAGING_SUPABASE_URL"));
const key = required("STAGING_SUPABASE_SERVICE_ROLE_KEY");
const password = required("FILLETRY_PREVIEW_DEMO_PASSWORD");
const email = process.env.FILLETRY_PREVIEW_DEMO_EMAIL ?? "owner@preview-demo.test";
const prodRef = process.env.SUPABASE_PROD_PROJECT_REF;
const loopback = ["127.0.0.1", "localhost"].includes(url.hostname); // rehearsal on a local stack
if (url.protocol !== "https:" && !loopback) {
  throw new Error("preview-demo-org: staging URL must be https");
}
if (prodRef && url.hostname.startsWith(`${prodRef}.`)) {
  throw new Error("preview-demo-org: refusing to write the demo org to the prod project");
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function call(path, init) {
  const res = await fetch(new URL(path, url), {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, json: body ? JSON.parse(body) : null };
}

async function upsert(table, conflict, rows) {
  const res = await call(`/rest/v1/${table}?on_conflict=${conflict}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`preview-demo-org: upsert ${table} failed (${res.status})`);
}

await upsert("org", "id", {
  id: DEMO_ORG_ID,
  slug: "preview-demo",
  name: "Preview Demo",
  timezone: "America/Anchorage",
  is_active: true,
});
await upsert("site", "org_id,name", [
  { org_id: DEMO_ORG_ID, name: "Main", is_default: true },
  { org_id: DEMO_ORG_ID, name: "Lodge", is_default: false },
]);

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
  if (!lookup.ok || !lookup.json)
    throw new Error(`preview-demo-org: cannot create or find ${email}`);
  userId = lookup.json;
  const reset = await call(`/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
  if (!reset.ok) throw new Error(`preview-demo-org: cannot reset the password of ${email}`);
}

await upsert("org_member", "org_id,user_id", {
  org_id: DEMO_ORG_ID,
  user_id: userId,
  role: "owner",
  display_name: "Preview Demo Owner",
  is_default: true,
});

console.log(`preview-demo-org: org preview-demo ready on ${url.host}; owner ${email}`);
