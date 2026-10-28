// Edge Functions get qr.ts as a generated copy (issue #79): the hosted bundler
// (`functions deploy --use-api`) ships only supabase/functions/**, so a function cannot import
// packages/rules. `pnpm --filter rules gen:functions` writes QR_FUNCTIONS_PATH from
// QR_SOURCE_PATH and functions-qr.test.ts fails while the copy is stale, so qr.ts stays the
// only producer of QR and status-page text (AGENTS.md rule 4).
export const QR_SOURCE_PATH = "packages/rules/src/qr.ts";
export const QR_FUNCTIONS_PATH = "supabase/functions/_shared/qr.generated.ts";

/** The functions copy of qr.ts. Throws if qr.ts gains an import the copy could not resolve. */
export function renderFunctionsQr(source: string): string {
  const text = source.replaceAll("\r\n", "\n");
  if (/^\s*(?:import\b|export\b[^;\n]*\bfrom\s)/m.test(text)) {
    throw new Error(`${QR_SOURCE_PATH} must stay import-free to be copied into Edge Functions`);
  }
  return `// GENERATED from ${QR_SOURCE_PATH} by \`pnpm --filter rules gen:functions\`. Do not edit.\n\n${text}`;
}
