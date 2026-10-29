// `pnpm db:seed-demo`: fills the local demo org `demo-plant` (docs/01-ARCHITECTURE.md §8)
// with everything the e2e smoke needs — processing rules + default rate card (the same
// payload onboarding uses), demo rates, a lodge, customers, asset tags, freezer locations,
// box sizes and one intake in EVERY intake state with lines, tote tags and vessels that match
// the state. Local Supabase only. Idempotent: ids are derived from stable names and every insert
// ignores rows that already exist, so re-running changes nothing.
//
// Runs on plain Node (type stripping): node --experimental-strip-types scripts/seed-demo-org.ts
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { encode, normalizeTagCode } from "../packages/rules/src/qr.ts";
import { referenceSeed } from "../packages/rules/src/reference-seed.ts";
import { SEED } from "../packages/rules/src/seed.ts";

const ORG_ID = "00000000-0000-4000-8000-000000000001"; // supabase/seed.sql
const ORG_SLUG = "demo-plant";
const root = join(import.meta.dirname, "..");

const out = execSync("pnpm exec supabase status -o json", {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const status = JSON.parse(out.slice(out.indexOf("{"))) as {
  API_URL: string;
  SERVICE_ROLE_KEY: string;
};
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(status.API_URL)) {
  throw new Error("seed-demo-org only runs against a local Supabase");
}

const headers = {
  apikey: status.SERVICE_ROLE_KEY,
  Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${status.API_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Inserts rows, leaving any that already exist (same primary key / `onConflict`) alone. */
async function insertMissing(table: string, rows: object[], onConflict = "id"): Promise<void> {
  if (rows.length === 0) return;
  await rest(`${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

/** A stable uuid (v5-style, sha1) per demo name, so re-runs address the same rows. */
function id(name: string): string {
  const h = createHash("sha1").update(`filletry-demo:${name}`).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

function factor(species: string, condition: string, method: string): number {
  const row = SEED.yield_table.find(
    (r) => r.species === species && r.condition === condition && r.processing === method,
  );
  if (!row) throw new Error(`no seeded yield for ${species}/${condition}/${method}`);
  return row.factor;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

// 1. Org, sites, processing rules, default rate card -------------------------------------
await insertMissing(
  "org",
  [{ id: ORG_ID, slug: ORG_SLUG, name: "Demo Plant", timezone: "America/Anchorage" }],
  "slug",
);
await insertMissing(
  "site",
  [
    { id: id("site:main"), org_id: ORG_ID, name: "Main", is_default: true },
    { id: id("site:lodge"), org_id: ORG_ID, name: "Lodge", is_default: false },
  ],
  "org_id,name",
);
const [mainSite] = (await rest(`site?org_id=eq.${ORG_ID}&is_default=is.true&select=id`)) as {
  id: string;
}[];

const seeded = (await rest("rpc/seed_org_reference", {
  method: "POST",
  body: JSON.stringify({ p_org_id: ORG_ID, p_reference: referenceSeed() }),
})) as { rate_card_id: string };
const rateCardId = seeded.rate_card_id;

// The demo is fully featured so e2e is never blocked by a plan gate. Real orgs get their
// plan only from the Stripe webhook (billing_apply_subscription).
await rest(`org?id=eq.${ORG_ID}&plan=is.null`, {
  method: "PATCH",
  body: JSON.stringify({ plan: "enterprise" }),
});

// Demo prices, only on lines still at the onboarding $0.00 (never overwrites edits).
const DEMO_RATES: Record<string, number> = {
  portions: 2.25,
  fillets: 1.95,
  smoking: 4.5,
  smoked_exchange_traditional: 6.0,
  smoked_exchange_cajun: 6.25,
  freeze: 0.75,
  head_off: 0.5,
  as_is: 0.6,
  ribbing_per_lb: 0.5,
  fast_pass_per_lb: 3.5,
  storage_per_box_day: 1.0,
};
for (const [key, amount] of Object.entries(DEMO_RATES)) {
  await rest(`rate_card_line?rate_card_id=eq.${rateCardId}&key=eq.${key}&amount=eq.0`, {
    method: "PATCH",
    body: JSON.stringify({ amount }),
  });
}

// 2. Lodge and customers ----------------------------------------------------------------
const lodgeId = id("lodge:kenai-river");
await insertMissing("lodge", [
  { id: lodgeId, org_id: ORG_ID, name: "Kenai River Lodge", pricing_cap: 1.5 },
]);

const CUSTOMERS = [
  { key: "alice", name: "Alice Angler", phone: "+19075550101" },
  { key: "bob", name: "Bob Boatman", phone: "+19075550102", lodge: true },
  { key: "carol", name: "Carol Caster", phone: "+19075550103" },
  { key: "dave", name: "Dave Dipnet", phone: "+19075550104" },
  { key: "erin", name: "Erin Eddy", phone: "+19075550105", lodge: true },
  { key: "frank", name: "Frank Fluke", phone: "+12065550106" },
  { key: "gina", name: "Gina Gaff", phone: "+19075550107" },
  { key: "hank", name: "Hank Halibut", phone: "+19075550108" },
];
await insertMissing(
  "customer",
  CUSTOMERS.map((c) => ({
    id: id(`customer:${c.key}`),
    org_id: ORG_ID,
    name: c.name,
    phone: c.phone,
    email: `${c.key}@demo-plant.test`,
    is_lodge_guest: c.lodge ?? false,
    lodge_id: c.lodge ? lodgeId : null,
  })),
);

// 3. Asset tags 1–20 and freezer locations (one built rack + a pallet) --------------------
// Codes at the org's width (4 digits for a new org: 0001); fixtures below name tags by their
// 3-digit key ("001"), which also keeps the row ids stable.
const [demoOrg] = (await rest(`org?id=eq.${ORG_ID}&select=settings`)) as {
  settings: { scanner: { tag_digits: number } };
}[];
if (!demoOrg) throw new Error("demo-plant org missing");
const tagDigits = demoOrg.settings.scanner.tag_digits;
await insertMissing(
  "asset_tag",
  Array.from({ length: 20 }, (_, i) => {
    const key = String(i + 1).padStart(3, "0");
    const code = normalizeTagCode(key, tagDigits)!;
    return {
      id: id(`tag:${key}`),
      org_id: ORG_ID,
      code,
      qr: encode("TAG", { orgSlug: ORG_SLUG, code }, { tagDigits }),
    };
  }),
  "org_id,code",
);

const locations: object[] = [];
for (const bay of [1, 2]) {
  for (const level of [1, 2]) {
    for (const depth of ["F", "R"] as const) {
      const code = `IF-A-${String(bay).padStart(2, "0")}-${level}-${depth}`;
      locations.push({
        id: id(`loc:${code}`),
        org_id: ORG_ID,
        zone: "IF",
        kind: "rack",
        row: "A",
        bay,
        level,
        depth,
        code,
        qr: encode("LOC", { orgSlug: ORG_SLUG, code }),
        capacity: 4,
      });
    }
  }
}
locations.push({
  id: id("loc:IF-PALLET-01"),
  org_id: ORG_ID,
  zone: "IF",
  kind: "pallet",
  row: null,
  bay: null,
  level: null,
  depth: null,
  code: "IF-PALLET-01",
  qr: encode("LOC", { orgSlug: ORG_SLUG, code: "IF-PALLET-01" }),
  capacity: null,
});
await insertMissing("location", locations, "org_id,code");

// Box sizes for counter allocation box plans (the e2e smoke plans a will-call box).
await insertMissing(
  "box_size",
  [
    { id: id("box:25"), org_id: ORG_ID, name: "25 lb box", max_lb: 25, fee: 6.0 },
    { id: id("box:50"), org_id: ORG_ID, name: "50 lb box", max_lb: 50, fee: 9.0 },
  ],
  "org_id,name",
);

// 4. One intake per state ------------------------------------------------------------------
type Line = { species: string; condition: string; method: string; lb: number };
type DemoIntake = {
  number: string;
  state: string;
  customer: string;
  hoursAgo: number;
  totes: number;
  lines: Line[];
  fastPass?: boolean;
  /** Vessels after reconcile: tag code (null = untagged exchange), location code. */
  vessels?: { tag: string | null; weight: number; location?: string; emptied?: boolean }[];
};

const reds = (condition: string, method: string, lb: number): Line => ({
  species: "salmon_reds",
  condition,
  method,
  lb,
});

// INT-0001 is the WP-05 station gallery fixture in supabase/seed.sql; the demo starts at 0002.
const INTAKES: DemoIntake[] = [
  {
    number: "INT-0002",
    state: "draft",
    customer: "alice",
    hoursAgo: 1,
    totes: 1,
    lines: [reds("filleted", "fillets", 22)],
  },
  {
    number: "INT-0003",
    state: "holding",
    customer: "bob",
    hoursAgo: 6,
    totes: 2,
    lines: [
      reds("filleted_ribs", "portions", 30),
      { species: "whitefish_halibut", condition: "hg", method: "portions", lb: 45 },
    ],
  },
  {
    number: "INT-0004",
    state: "processing",
    customer: "carol",
    hoursAgo: 30,
    totes: 1,
    fastPass: true,
    lines: [reds("filleted", "smoking", 18)],
  },
  {
    number: "INT-0005",
    state: "rollstock",
    customer: "dave",
    hoursAgo: 40,
    totes: 2,
    lines: [{ species: "salmon_kings", condition: "gutted", method: "fillets", lb: 60 }],
  },
  {
    number: "INT-0006",
    state: "reconcile",
    customer: "erin",
    hoursAgo: 50,
    totes: 1,
    lines: [reds("filleted", "portions", 25)],
    vessels: [{ tag: "001", weight: 24 }],
  },
  {
    number: "INT-0007",
    state: "blast_freezer",
    customer: "frank",
    hoursAgo: 60,
    totes: 2,
    lines: [
      reds("filleted", "smoked_exchange_traditional", 20),
      { species: "whitefish_rockfish", condition: "whole", method: "portions", lb: 35 },
    ],
    vessels: [
      { tag: null, weight: 14 },
      { tag: "002", weight: 21 },
    ],
  },
  {
    number: "INT-0008",
    state: "stored",
    customer: "gina",
    hoursAgo: 80,
    totes: 1,
    lines: [{ species: "salmon_silvers", condition: "filleted", method: "fillets", lb: 28 }],
    vessels: [{ tag: "003", weight: 27, location: "IF-A-01-1-F" }],
  },
  {
    number: "INT-0009",
    state: "done",
    customer: "hank",
    hoursAgo: 120,
    totes: 1,
    lines: [{ species: "whitefish_halibut", condition: "filleted", method: "portions", lb: 40 }],
    vessels: [{ tag: null, weight: 40, emptied: true }],
  },
  {
    number: "INT-0010",
    state: "cancelled",
    customer: "alice",
    hoursAgo: 96,
    totes: 1,
    lines: [reds("as_is", "as_is", 10)],
  },
];

// States in pipeline order; each passed state stamps its timestamp column.
const STAMPS: [string, string][] = [
  ["processing", "pulled_at"],
  ["rollstock", "rollstock_at"],
  ["reconcile", "reconcile_at"],
  ["blast_freezer", "blast_at"],
  ["stored", "stored_at"],
  ["done", "done_at"],
];

// The demo numbers belong to this script. Anything else holding one (another fixture, an
// intake made in the app before seeding) would 409 on (org_id, number) — say why instead.
const taken = (await rest(
  `intake?org_id=eq.${ORG_ID}&number=in.(${INTAKES.map((i) => i.number).join(",")})&select=id,number`,
)) as { id: string; number: string }[];
const foreign = taken.filter((t) => t.id !== id(`intake:${t.number}`)).map((t) => t.number);
if (foreign.length > 0) {
  throw new Error(
    `demo-plant already has ${foreign.join(", ")} not created by seed-demo-org; ` +
      "run `supabase db reset` first (supabase/seed.sql must not seed demo intakes)",
  );
}

for (const demo of INTAKES) {
  const intakeId = id(`intake:${demo.number}`);
  const at = hoursAgo(demo.hoursAgo);
  const reached = STAMPS.findIndex(([s]) => s === demo.state);
  const stamps = Object.fromEntries(
    STAMPS.slice(0, reached + 1).map(([, col], i) => [col, hoursAgo(demo.hoursAgo - 4 * (i + 1))]),
  );
  if (reached >= 2) stamps.rollstock_done_at = stamps.reconcile_at;
  if (demo.state === "cancelled") stamps.cancelled_at = hoursAgo(demo.hoursAgo - 2);
  const customer = CUSTOMERS.find((c) => c.key === demo.customer)!;

  await insertMissing("intake", [
    {
      id: intakeId,
      org_id: ORG_ID,
      number: demo.number,
      customer_id: id(`customer:${demo.customer}`),
      site_id: mainSite?.id ?? null,
      state: demo.state,
      intake_at: at,
      estimated_pickup_at: hoursAgo(demo.hoursAgo - 72),
      tote_count: demo.totes,
      fast_pass: demo.fastPass ?? false,
      is_lodge_guest: customer.lodge ?? false,
      rate_card_id: rateCardId,
      locked: demo.state !== "draft",
      ...stamps,
    },
  ]);
  await insertMissing(
    "intake_line",
    demo.lines.map((l, i) => ({
      id: id(`line:${demo.number}:${i}`),
      org_id: ORG_ID,
      intake_id: intakeId,
      sort: (i + 1) * 10,
      species_code: l.species,
      condition_code: l.condition,
      method_code: l.method,
      lb: l.lb,
      yield_factor: factor(l.species, l.condition, l.method),
    })),
  );
  if (demo.state !== "draft") {
    await insertMissing(
      "tote_tag",
      Array.from({ length: demo.totes }, (_, i) => ({
        id: id(`tote:${demo.number}:${i + 1}`),
        org_id: ORG_ID,
        intake_id: intakeId,
        tote_no: i + 1,
        of_count: demo.totes,
        qr: encode("TOTE", { intakeNumber: demo.number, toteNo: i + 1 }),
        printed_at: at,
      })),
    );
  }

  for (const [i, v] of (demo.vessels ?? []).entries()) {
    const vesselId = id(`vessel:${demo.number}:${i}`);
    const tagId = v.tag ? id(`tag:${v.tag}`) : null;
    const isExchange =
      v.tag === null && demo.lines.some((l) => l.method.startsWith("smoked_exchange"));
    await insertMissing("vessel", [
      {
        id: vesselId,
        org_id: ORG_ID,
        intake_id: intakeId,
        asset_tag_id: v.emptied ? null : tagId,
        is_exchange: isExchange,
        weight_lb: v.emptied ? 0 : v.weight,
        species_summary: demo.lines.map((l) => l.species).join(", "),
        lifecycle_state: v.emptied ? "emptied" : "occupied",
        location_id: v.location ? id(`loc:${v.location}`) : null,
        blast_in_at: reached >= 3 ? stamps.blast_at : null,
        blast_out_at: reached >= 4 ? stamps.stored_at : null,
        stored_at: reached >= 4 ? stamps.stored_at : null,
        emptied_at: v.emptied ? stamps.done_at : null,
        release_snapshot: v.emptied ? { weight_lb: v.weight } : null,
      },
    ]);
    if (tagId && !v.emptied) {
      // available → in_use (a guarded edge); a re-run finds the tag already in use.
      await rest(`asset_tag?id=eq.${tagId}&state=eq.available`, {
        method: "PATCH",
        body: JSON.stringify({ state: "in_use", current_vessel_id: vesselId }),
      });
    }
    if (v.location) {
      await insertMissing("location_placement", [
        {
          id: id(`placement:${demo.number}:${i}`),
          org_id: ORG_ID,
          vessel_id: vesselId,
          location_id: id(`loc:${v.location}`),
          placed_at: stamps.stored_at,
          station: "locate",
        },
      ]);
    }
  }
}

// New intakes continue after the highest demo number (app.next_seq stores the last value
// issued); never lower a counter the org has already moved past.
const lastNumber = Math.max(...INTAKES.map((i) => Number(i.number.slice("INT-".length))));
await insertMissing(
  "sequence_counter",
  [{ org_id: ORG_ID, kind: "intake", value: lastNumber }],
  "org_id,kind",
);
await rest(`sequence_counter?org_id=eq.${ORG_ID}&kind=eq.intake&value=lt.${lastNumber}`, {
  method: "PATCH",
  body: JSON.stringify({ value: lastNumber }),
});

console.log(
  `demo-plant ready: ${CUSTOMERS.length} customers, 20 asset tags, ${locations.length} locations, 2 box sizes, ` +
    `intakes in ${INTAKES.length} states (${INTAKES.map((i) => i.state).join(", ")}).`,
);
