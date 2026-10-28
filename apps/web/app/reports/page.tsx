import { adminPageSession } from "@/lib/auth";
import { loadReports, parseReportFilters, type ReportParams } from "@/lib/reports";
import { ReportsDashboard } from "@/components/reports/dashboard";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<ReportParams>;
}) {
  const session = await adminPageSession();
  if (!session) return <main className="p-6">Reports are for owners and managers.</main>;
  const { supabase, claims } = session;
  const [org, sites] = await Promise.all([
    supabase.from("org").select("timezone").eq("id", claims.orgId).single(),
    supabase.from("site").select("id,name").order("name"),
  ]);
  if (org.error || sites.error) throw new Error("Could not load report settings.");
  let filters;
  try {
    filters = parseReportFilters(await searchParams, org.data.timezone);
  } catch {
    return (
      <main className="p-6">
        <h1 className="text-3xl font-semibold">Reports</h1>
        <p role="alert">Choose valid dates (start on or before end) and a valid site.</p>
        <a href="/reports" className="underline">
          Reset filters
        </a>
      </main>
    );
  }
  const data = await loadReports(supabase, filters);
  return (
    <ReportsDashboard
      filters={filters}
      data={data}
      sites={sites.data}
      timezone={org.data.timezone}
    />
  );
}
