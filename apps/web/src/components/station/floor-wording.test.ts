// Issue #98 (docs/11-FLOOR-WORDING.md): floor screens say order / tote / basket / location / box.
// Lint-style: every string literal, template text and JSX text in a floor-station component (not
// its comments, identifiers, table/column names or query strings) is checked for a banned word.
// The operator-facing SQL reasons are checked by supabase/tests/29_floor_wording.test.sql.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const web = resolve(import.meta.dirname, "../../..");

/** Floor stations, their shared primitives, the receipts and the customer status page. */
const FLOOR = [
  "src/components/station",
  "components/wave",
  "components/rollstock",
  "components/reconcile",
  "components/variance",
  "components/freezer",
  "components/boxing",
  "components/storage/storage-detail.tsx",
  "components/intake/intake-receipt.tsx",
  "components/allocate/settlement-receipt.tsx",
  "components/register/payment-receipt.tsx",
  "app/pair/pair-device.tsx",
  "app/s/[orgSlug]",
  "app/device/device-home.tsx",
  "app/dev/stations/station-demo.tsx",
  "app/dev/station-gallery",
];

/**
 * vessel, bin, asset tag, intake as a noun ("Intake station" keeps its name), "Type code",
 * "Ready to scan". `\b` treats `_` as a word character, so `vessel_id` / `intake_number` pass.
 */
export const BANNED =
  /\b(vessels?|bins?)\b|\basset tags?\b|\bintakes?\b(?! station)|\btype code\b|\bready to scan\b/i;

// Query-builder and storage calls take table, column and key names, not floor text.
const CODE_CALLS = new Set([
  "from",
  "select",
  "eq",
  "neq",
  "in",
  "is",
  "order",
  "rpc",
  "channel",
  "on",
  "filter",
  "getItem",
  "setItem",
  "request",
]);

function files(path: string): string[] {
  const full = join(web, path);
  if (/\.tsx?$/.test(path)) return [full];
  return readdirSync(full)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(full, f));
}

function isCodeArgument(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) return parent.name.getText() === "className";
  return (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    CODE_CALLS.has(parent.expression.name.text)
  );
}

/** Operator-visible text in one source file: [line, text] for each literal or JSX text. */
export function floorText(source: string, name = "file.tsx"): Array<[number, string]> {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<[number, string]> = [];
  const add = (node: ts.Node, text: string) =>
    out.push([file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text]);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isJsxText(node)) {
      if (node.text.trim()) add(node, node.text.trim());
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // A lowercase word with no space is a key, enum value or table name, not floor text.
      if (!isCodeArgument(node) && (/\s/.test(node.text) || /^[A-Z]/.test(node.text)))
        add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      if (!isCodeArgument(node))
        add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" … "));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

describe("#98 floor wording", () => {
  it("the banned-word rule catches the old floor words and lets code names and Intake station pass", () => {
    for (const bad of [
      "Add exchange vessel (no tag)",
      "Remove selected vessel",
      "Fix the bins",
      "Move this bin",
      "asset tag pool",
      "Scan a tote or choose an intake",
      "No open intakes found",
      "Type code",
      "Ready to scan",
    ])
      expect(bad).toMatch(BANNED);
    for (const ok of [
      "vessel_id",
      "intake_number",
      "Intake station",
      "Basket 005 added to INT-0002",
      "Enter manually",
      "Scan basket",
    ])
      expect(ok).not.toMatch(BANNED);
  });

  it("text extraction skips comments, imports, types and query-builder names", () => {
    const text = floorText(`
      // an intake comment with a vessel
      import { x } from "intake vessel";
      type T = Database["public"]["Tables"]["intake"]["Row"];
      client.from("vessel").select("id, intake:intake_id (number)").eq("intake_id", id);
      const a = <p className="intake-header">Scan basket {n} of the order</p>;
      const b = "Vessel";
      const c = \`Basket \${code} added\`;
    `).map(([, t]) => t);
    expect(text).toEqual(["Scan basket", "of the order", "Vessel", "Basket  …  added"]);
  });

  it("no floor screen says vessel, bin, asset tag, intake, Type code or Ready to scan", () => {
    const found = FLOOR.flatMap(files).flatMap((path) =>
      floorText(readFileSync(path, "utf8"), path)
        .filter(([, text]) => BANNED.test(text))
        .map(([line, text]) => `${relative(web, path).replaceAll("\\", "/")}:${line} ${text}`),
    );
    expect(found).toEqual([]);
  });
});
