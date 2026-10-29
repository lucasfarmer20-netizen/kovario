// D1 repo sweep (docs/10-LESSONS-FROM-CSP.md §1–§2, AGENTS.md hard rule 2): occupancy and
// "fish gone" are read ONLY from vessel.lifecycle_state, never from asset_tag_id. This test
// greps every SQL and TS source for asset_tag_id null / equality / truthiness predicates and
// fails on any hit that is not on the allowlist below — each allowlisted line is tag
// identity / reuse code, not an occupancy read. A stale allowlist entry fails too, so the
// list never outlives the code it excuses.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const ROOTS = ["supabase", "packages", "apps", "agent", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "coverage", ".turbo"]);
const EXTENSIONS = /\.(sql|ts|tsx|mts|cts|js|mjs|cjs)$/;
const SELF = "packages/db/src/occupancy-sweep.test.ts";
// Generated from the live schema (column declarations only).
const SKIP_FILES = new Set(["packages/db/src/types.ts"]);

/** asset_tag_id used as a null / equality / truthiness predicate. */
const OCCUPANCY_PATTERNS: RegExp[] = [
  /asset_tag_id\s+is\s+(not\s+)?null/i, // SQL
  /asset_tag_id\s*[!=]==?/, // TS == / === / != / !==
  /\.(is|not)\(\s*["'`]asset_tag_id["'`]/, // supabase-js .is("asset_tag_id", null)
  /!\s*[\w$.?]*\.asset_tag_id\b/, // TS truthiness: !v.asset_tag_id
  /asset_tag_id\s*\?\?/, // TS nullish fallback
];

type Allowed = { file: string; line: string; why: string };

/** Tag identity / reuse code. `line` is a substring of the offending (trimmed) line. */
const ALLOWLIST: Allowed[] = [
  {
    file: "supabase/migrations/20261026150000_floor.sql",
    line: "check (not is_exchange or asset_tag_id is null)",
    why: "identity: smoked-exchange baskets are never tagged",
  },
  {
    file: "supabase/migrations/20261026150000_floor.sql",
    line: "where asset_tag_id is not null and lifecycle_state = 'occupied'",
    why: "identity: a tag sits on at most one occupied vessel (unique index); occupancy is the lifecycle_state term",
  },
  {
    file: "supabase/migrations/20261027051000_reconcile.sql",
    line: "(not is_exchange and asset_tag_id is null)",
    why: "identity: send-to-blast requires every non-exchange vessel to carry a tag",
  },
  {
    file: "supabase/tests/12_reconcile.test.sql",
    line: "is_exchange and asset_tag_id is null and lifecycle_state='occupied'",
    why: "test: an untagged exchange basket is still occupied",
  },
  {
    file: "supabase/migrations/20261029010000_exchange_vessel_freezers.sql",
    line: "if v.asset_tag_id is not null then",
    why: "identity (#86): a tagged vessel is scanned, never taken by id; occupancy is the lifecycle_state check below",
  },
  {
    file: "supabase/migrations/20261029010000_exchange_vessel_freezers.sql",
    line: "if v.id is null or v.asset_tag_id is not null then",
    why: "identity (#86): a by-id locate selection must be tagless; the row was read with lifecycle_state='occupied'",
  },
  {
    file: "apps/web/components/freezer/locate-station.tsx",
    line: '.is("asset_tag_id", null)',
    why: "identity (#86): lists tagless baskets for tap selection; occupancy is the lifecycle_state filter",
  },
];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (EXTENSIONS.test(entry.name)) yield path;
  }
}

type Hit = { file: string; lineNo: number; line: string };

function sweep(): Hit[] {
  const hits: Hit[] = [];
  for (const top of ROOTS) {
    let files: Generator<string>;
    try {
      files = sources(join(root, top));
    } catch {
      continue;
    }
    for (const path of files) {
      const file = relative(root, path).split(sep).join("/");
      if (file === SELF || SKIP_FILES.has(file)) continue;
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .forEach((text, i) => {
          if (OCCUPANCY_PATTERNS.some((p) => p.test(text)))
            hits.push({ file, lineNo: i + 1, line: text.trim() });
        });
    }
  }
  return hits;
}

const allowed = (h: Hit) => ALLOWLIST.some((a) => a.file === h.file && h.line.includes(a.line));

describe("D1 occupancy sweep", () => {
  const hits = sweep();

  it("no asset_tag_id predicate outside the tag identity / reuse allowlist", () => {
    const offenders = hits
      .filter((h) => !allowed(h))
      .map((h) => `${h.file}:${h.lineNo}  ${h.line}`);
    expect(offenders, "read occupancy from vessel.lifecycle_state instead").toEqual([]);
  });

  it("every allowlist entry still matches a line (no stale excuses)", () => {
    const stale = ALLOWLIST.filter(
      (a) => !hits.some((h) => h.file === a.file && h.line.includes(a.line)),
    ).map((a) => `${a.file}: ${a.line}`);
    expect(stale).toEqual([]);
  });

  it("the patterns catch the predicates they are for", () => {
    for (const bad of [
      "where v.asset_tag_id is null",
      "and asset_tag_id IS NOT NULL",
      "if (vessel.asset_tag_id === null) gone()",
      "v.asset_tag_id != null",
      'query.is("asset_tag_id", null)',
      'query.not("asset_tag_id", "is", null)',
      "const gone = !row.asset_tag_id;",
      "const tag = v.asset_tag_id ?? fallback",
    ]) {
      expect(
        OCCUPANCY_PATTERNS.some((p) => p.test(bad)),
        bad,
      ).toBe(true);
    }
    for (const ok of [
      "left join public.asset_tag t on t.id = v.asset_tag_id",
      "where v.lifecycle_state = 'occupied'",
      "select code from public.asset_tag where id = p_vessel.asset_tag_id",
    ]) {
      expect(
        OCCUPANCY_PATTERNS.some((p) => p.test(ok)),
        ok,
      ).toBe(false);
    }
  });
});
