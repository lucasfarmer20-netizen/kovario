import { adminPageSession } from "@/lib/auth";
import { isReportKind, loadReport, parseReportFilters, reportCsv } from "@/lib/reports";

export async function GET(request: Request) {
  const session = await adminPageSession();
  if (!session) return new Response("Reports are for owners and managers.", { status: 403 });
  const params = new URL(request.url).searchParams;
  const kind = params.get("report") ?? "";
  if (!isReportKind(kind)) return new Response("Unknown report.", { status: 400 });
  const { supabase, claims } = session;
  const [org, sites] = await Promise.all([
    supabase.from("org").select("timezone").eq("id", claims.orgId).single(),
    supabase.from("site").select("id,name").order("name"),
  ]);
  if (org.error || sites.error)
    return new Response("Could not load report settings.", { status: 500 });
  let filters;
  try {
    filters = parseReportFilters(Object.fromEntries(params), org.data.timezone);
  } catch {
    return new Response("Invalid date range or site.", { status: 400 });
  }
  const rows = await loadReport(supabase, kind, filters);
  return new Response(
    reportCsv(kind, rows, Object.fromEntries(sites.data.map((s) => [s.id, s.name]))),
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${kind}-${filters.from}-${filters.to}.csv"`,
        "Cache-Control": "private, no-store",
      },
    },
  );
}
