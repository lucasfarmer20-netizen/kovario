// `pnpm db:preview-demo`: creates or refreshes the throwaway demo org that Vercel preview
// deployments sign in to on **staging** (docs/01-ARCHITECTURE.md §8, docs/11-DEPLOY.md §4).
// Idempotent: upserts org `preview-demo` and its sites, adds the processing reference data and
// default rate card the same way onboarding does (public.seed_org_reference with
// referenceSeed(); existing rows are kept), then the demo owner (password reset to the given
// one) and the owner membership. Never run it against prod; hosted deploys never seed.
// Runs on Node with type stripping: `pnpm db:preview-demo`.
//   STAGING_SUPABASE_URL               https://<staging-ref>.supabase.co
//   SUPABASE_STAGING_PROJECT_REF       the staging ref; any other host is refused (positive
//                                      match, so prod can never be hit by a wrong URL)
//   STAGING_SUPABASE_SERVICE_ROLE_KEY  staging service-role key (never commit it)
//   FILLETRY_PREVIEW_DEMO_PASSWORD     password for the demo owner
//   FILLETRY_PREVIEW_DEMO_EMAIL        default owner@preview-demo.test
// A loopback URL (local stack rehearsal) needs no ref.
import { referenceSeed } from "../packages/rules/src/reference-seed.ts";

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
const loopback = ["127.0.0.1", "localhost"].includes(url.hostname); // rehearsal on a local stack
if (!loopback) {
  const stagingHost = `${required("SUPABASE_STAGING_PROJECT_REF").trim()}.supabase.co`;
  if (url.protocol !== "https:" || url.hostname !== stagingHost) {
    throw new Error("preview-demo-org: STAGING_SUPABASE_URL is not the staging project; refusing");
  }
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
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // non-JSON error page (gateway, HTML); callers report the status
  }
  return { ok: res.ok, status: res.status, json };
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

const seeded = await call("/rest/v1/rpc/seed_org_reference", {
  method: "POST",
  body: JSON.stringify({ p_org_id: DEMO_ORG_ID, p_reference: referenceSeed() }),
});
if (!seeded.ok) throw new Error(`preview-demo-org: seed_org_reference failed (${seeded.status})`);

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
