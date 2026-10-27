// Renders the SQL forms of the two rules the database must apply on its own: the pricing
// rule (save_intake prices charge drafts and the lodge-flip reprice runs inside the flip's
// transaction, so neither can call TypeScript) and the tote-tag QR text (save_intake creates
// tote_tag rows in the same transaction that assigns the intake number). Like states-sql.ts,
// this file is the only place the SQL is written: `pnpm --filter rules gen:sql` writes the
// migration, a test fails when the committed file is stale, and a db test checks
// app.price_per_lb against pricePerLb over a grid of inputs.
import { INTAKE_NUMBER, QR_PREFIX } from "./qr.ts";
import { RIBBING_ITEM } from "./pricing.ts";

export const RULES_SQL_PATH = "supabase/migrations/20261027000000_rules_sql.sql";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderRulesSql(): string {
  return [
    "-- GENERATED from packages/rules/src/rules-sql.ts — do not edit by hand.",
    "-- Regenerate with `pnpm --filter rules gen:sql`; a rules test fails when this is stale.",
    "-- SQL forms of rules the database applies inside its own transactions:",
    "--   app.price_per_lb — the ONE pricing rule (docs/04-BUSINESS-RULES.md §2, pricing.ts);",
    "--   app.qr_tote      — tote-tag QR text (docs/02-DOMAIN-MODEL.md §13, qr.ts).",
    "",
    "-- fast_pass      ? max(list_price, fast_pass_rate)   floor; overrides the cap",
    "-- is_lodge_guest ? min(list_price, lodge_cap)        lodge_cappable methods only",
    "-- :                list_price",
    `-- The ${RIBBING_ITEM} item is never floored or capped (DECISION-19).`,
    "create or replace function app.price_per_lb(",
    "  p_item text,",
    "  p_list_price numeric,",
    "  p_fast_pass boolean,",
    "  p_fast_pass_rate numeric,",
    "  p_is_lodge_guest boolean,",
    "  p_lodge_cap numeric,",
    "  p_lodge_cappable boolean",
    ")",
    "returns numeric",
    "language plpgsql",
    "immutable",
    "set search_path = ''",
    "as $$",
    "begin",
    "  if p_list_price is null or p_list_price < 0 then",
    "    raise exception 'listPrice must be finite and >= 0' using errcode = '22023';",
    "  end if;",
    `  if p_item = ${literal(RIBBING_ITEM)} then`,
    "    return p_list_price;",
    "  end if;",
    "  if p_fast_pass then",
    "    if p_fast_pass_rate is null then",
    "      raise exception 'fastPass requires fastPassRate (rate card fast_pass_per_lb)'",
    "        using errcode = '22023';",
    "    end if;",
    "    if p_fast_pass_rate < 0 then",
    "      raise exception 'fastPassRate must be finite and >= 0' using errcode = '22023';",
    "    end if;",
    "    return greatest(p_list_price, p_fast_pass_rate);",
    "  end if;",
    "  if p_is_lodge_guest and coalesce(p_lodge_cappable, true) and p_lodge_cap is not null then",
    "    if p_lodge_cap < 0 then",
    "      raise exception 'lodgeCap must be finite and >= 0' using errcode = '22023';",
    "    end if;",
    "    return least(p_list_price, p_lodge_cap);",
    "  end if;",
    "  return p_list_price;",
    "end;",
    "$$;",
    "",
    `-- ${QR_PREFIX}:TOTE:<INT-0001>:<n>, as encode('TOTE', …) produces it.`,
    "create or replace function app.qr_tote(p_intake_number text, p_tote_no int)",
    "returns text",
    "language plpgsql",
    "immutable",
    "set search_path = ''",
    "as $$",
    "begin",
    `  if p_intake_number is null or p_intake_number !~ ${literal(INTAKE_NUMBER.source)} then`,
    "    raise exception 'QR intake number is invalid: %', p_intake_number using errcode = '22023';",
    "  end if;",
    "  if p_tote_no is null or p_tote_no < 1 then",
    "    raise exception 'QR tote no must be a positive integer' using errcode = '22023';",
    "  end if;",
    `  return ${literal(`${QR_PREFIX}:TOTE:`)} || p_intake_number || ':' || p_tote_no::text;`,
    "end;",
    "$$;",
    "",
    "revoke all on function",
    "  app.price_per_lb(text, numeric, boolean, numeric, boolean, numeric, boolean),",
    "  app.qr_tote(text, int)",
    "from public;",
    "grant execute on function",
    "  app.price_per_lb(text, numeric, boolean, numeric, boolean, numeric, boolean),",
    "  app.qr_tote(text, int)",
    "to authenticated, service_role;",
    "",
  ].join("\n");
}
