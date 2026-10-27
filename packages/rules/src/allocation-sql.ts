// Renders the SQL forms of the allocation rules price_session applies inside its own
// transaction: the penny rule (splitAmount) and the boxing QR text the settlement receipt
// print job carries. Like rules-sql.ts this is the only place that SQL is written:
// `pnpm --filter rules gen:sql` writes the migration, a rules test fails when the committed
// file is stale, and packages/db allocation.db.test.ts checks app.split_amount ≡ splitAmount.
import { WEIGHT_SPLIT_NEEDS_LB } from "./allocation.ts";
import { BOXING_TOKEN, QR_PREFIX } from "./qr.ts";

export const ALLOCATION_SQL_PATH = "supabase/migrations/20261027061400_allocation_rules_sql.sql";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderAllocationSql(): string {
  return [
    "-- GENERATED from packages/rules/src/allocation-sql.ts — do not edit by hand.",
    "-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.",
    "--   app.split_amount — THE penny rule (docs/04-BUSINESS-RULES.md §8, allocation.ts);",
    "--   app.qr_box       — boxing QR text on the settlement receipt (qr.ts).",
    "",
    "-- Whole cents; floor of total × wᵢ / Σw each; the leftover cents (< n) one each to the",
    "-- largest remainders, a tie to the earlier share. Shares sum to the total exactly.",
    "create or replace function app.split_amount(p_total numeric, p_weights numeric[])",
    "returns numeric[]",
    "language plpgsql",
    "immutable",
    "set search_path = ''",
    "as $$",
    "declare",
    "  v_cents numeric;",
    "  v_sum numeric;",
    "  v_result numeric[];",
    "begin",
    "  if p_total is null or p_total < 0 or p_total * 100 <> trunc(p_total * 100) then",
    "    raise exception 'total must be a non-negative amount in cents' using errcode = '22023';",
    "  end if;",
    "  if coalesce(cardinality(p_weights), 0) = 0 then",
    "    raise exception 'split needs at least one share' using errcode = '22023';",
    "  end if;",
    "  if exists (select 1 from unnest(p_weights) x where x is null or x < 0 or x * 100 <> trunc(x * 100)) then",
    "    raise exception 'weights must be non-negative, at most 2 dp' using errcode = '22023';",
    "  end if;",
    "  v_cents := p_total * 100;",
    "  select sum(x * 100) into v_sum from unnest(p_weights) x;",
    "  if v_sum = 0 then",
    `    raise exception ${literal(WEIGHT_SPLIT_NEEDS_LB)} using errcode = '22023';`,
    "  end if;",
    "  with s as (",
    "    select w.ord, div(v_cents * w.x * 100, v_sum) as f, mod(v_cents * w.x * 100, v_sum) as r",
    "    from unnest(p_weights) with ordinality as w (x, ord)",
    "  ), ranked as (",
    "    select s.ord, s.f, row_number() over (order by s.r desc, s.ord) as rn,",
    "           v_cents - sum(s.f) over () as left_over",
    "    from s",
    "  )",
    "  select array_agg(((ranked.f + case when ranked.rn <= ranked.left_over then 1 else 0 end) / 100)::numeric(12,2)",
    "                   order by ranked.ord)",
    "  into v_result",
    "  from ranked;",
    "  return v_result;",
    "end;",
    "$$;",
    "",
    `-- ${QR_PREFIX}:BOX:<boxing_token>, as encode('BOX', …) produces it.`,
    "create or replace function app.qr_box(p_token text)",
    "returns text",
    "language plpgsql",
    "immutable",
    "set search_path = ''",
    "as $$",
    "begin",
    `  if p_token is null or p_token !~ ${literal(BOXING_TOKEN.source)} then`,
    "    raise exception 'QR boxing token is invalid' using errcode = '22023';",
    "  end if;",
    `  return ${literal(`${QR_PREFIX}:BOX:`)} || p_token;`,
    "end;",
    "$$;",
    "",
    "revoke all on function app.split_amount(numeric, numeric[]), app.qr_box(text) from public;",
    "grant execute on function app.split_amount(numeric, numeric[]), app.qr_box(text)",
    "to authenticated, service_role;",
    "",
  ].join("\n");
}
