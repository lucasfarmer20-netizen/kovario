import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STATE_TRANSITIONS_SQL_PATH, renderStateTransitionsSql } from "./states-sql.ts";
import {
  ENTITIES,
  STATES,
  STATE_COLUMN,
  TRANSITIONS,
  canTransition,
  isTerminal,
  nextStates,
  type Entity,
  type Transition,
} from "./states.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const edges = (e: Entity) => TRANSITIONS[e] as readonly Transition<Entity>[];

describe("generated SQL", () => {
  it("supabase/seed/state_transitions.sql is up to date (run `pnpm --filter rules gen:states`)", () => {
    const committed = readFileSync(resolve(repoRoot, STATE_TRANSITIONS_SQL_PATH), "utf8");
    expect(committed.replaceAll("\r\n", "\n")).toBe(renderStateTransitionsSql());
  });

  it("has one row per transition", () => {
    const rows = renderStateTransitionsSql()
      .split("\n")
      .filter((l) => l.startsWith("  ("));
    expect(rows).toHaveLength(ENTITIES.reduce((n, e) => n + edges(e).length, 0));
    expect(rows.at(-1)).toMatch(/\);$/);
  });
});

describe("transition tables", () => {
  it("only use declared states, with no duplicates or self-loops", () => {
    for (const e of ENTITIES) {
      const states = STATES[e] as readonly string[];
      const seen = new Set<string>();
      for (const t of edges(e)) {
        expect(states, `${e}: ${t.from}`).toContain(t.from);
        expect(states, `${e}: ${t.to}`).toContain(t.to);
        expect(t.from, e).not.toBe(t.to);
        const key = `${t.from}>${t.to}`;
        expect(seen.has(key), `${e} duplicate ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("state columns follow the domain model", () => {
    expect(STATE_COLUMN.vessel).toBe("lifecycle_state");
    expect(STATE_COLUMN.box_plan).toBe("fulfillment_state");
    expect(STATE_COLUMN.intake).toBe("state");
  });
});

describe("intake", () => {
  it("happy path draft → done", () => {
    const path = [
      "draft",
      "holding",
      "processing",
      "rollstock",
      "reconcile",
      "blast_freezer",
      "stored",
      "done",
    ] as const;
    for (let i = 1; i < path.length; i++) {
      expect(canTransition("intake", path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it("there is no `ready` state and no skipping stages", () => {
    expect(STATES.intake).not.toContain("ready");
    expect(canTransition("intake", "holding", "rollstock")).toBe(false);
    expect(canTransition("intake", "reconcile", "stored")).toBe(false);
  });

  it("close gate I10 may close from stored or blast_freezer", () => {
    expect(canTransition("intake", "blast_freezer", "done")).toBe(true);
    expect(canTransition("intake", "reconcile", "done")).toBe(false);
  });

  it("any non-terminal → cancelled, manager only", () => {
    for (const s of STATES.intake) {
      if (s === "done" || s === "cancelled") continue;
      expect(canTransition("intake", s, "cancelled"), s).toBe(false);
      expect(canTransition("intake", s, "cancelled", { isManager: true }), s).toBe(true);
    }
    expect(canTransition("intake", "done", "cancelled", { isManager: true })).toBe(false);
    expect(isTerminal("intake", "done")).toBe(true);
    expect(isTerminal("intake", "cancelled")).toBe(true);
  });
});

describe("vessel occupancy backbone", () => {
  it("full pull empties; restore and void are manager-only; void is terminal", () => {
    expect(canTransition("vessel", "occupied", "emptied")).toBe(true);
    expect(canTransition("vessel", "emptied", "occupied")).toBe(false);
    expect(canTransition("vessel", "emptied", "occupied", { isManager: true })).toBe(true);
    expect(canTransition("vessel", "occupied", "void", { isManager: true })).toBe(true);
    expect(isTerminal("vessel", "void")).toBe(true);
  });
});

describe("other machines", () => {
  it("box plans never roll back", () => {
    for (const s of ["shipped", "picked_up"] as const) expect(isTerminal("box_plan", s)).toBe(true);
    expect(canTransition("box_plan", "packed", "planned")).toBe(false);
  });

  it("a voided pickup batch can only be released by a manager", () => {
    expect(canTransition("storage_pickup_batch", "void", "released")).toBe(false);
    expect(canTransition("storage_pickup_batch", "void", "released", { isManager: true })).toBe(
      true,
    );
  });

  it("indeterminate payments resolve only by status check", () => {
    expect(nextStates("payment", "indeterminate")).toEqual(["approved", "declined", "cancelled"]);
    expect(canTransition("payment", "declined", "approved")).toBe(false);
    expect(nextStates("payment", "approved")).toEqual([]);
    expect(nextStates("payment", "approved", { isManager: true })).toEqual(["voided", "refunded"]);
  });

  it("asset tags cycle available ↔ in_use and retire/reactivate", () => {
    expect(nextStates("asset_tag", "available")).toEqual(["in_use", "retired"]);
    expect(canTransition("asset_tag", "retired", "in_use")).toBe(false);
  });

  it("failed print jobs retry", () => {
    expect(canTransition("print_job", "failed", "queued")).toBe(true);
  });
});
