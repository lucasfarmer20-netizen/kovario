"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parse } from "rules";
import type { StationSession } from "@/components/intake/use-station-session";
import { listSessions, sessionForBoxingToken, type SessionFilters } from "./allocate-data";
import { FULFILLMENT_LABELS, SESSION_STATE_LABELS, money } from "./allocate-state";

type Row = Awaited<ReturnType<typeof listSessions>>[number];

/**
 * Session list: filter by state and fulfillment rollup (allocation_session_list), search by
 * number, party, angler or intake; scanning a receipt's boxing QR opens its session.
 */
export function SessionList({ session }: { session: StationSession }) {
  const router = useRouter();
  const [filters, setFilters] = useState<SessionFilters>({ state: "open", fulfillment: "", q: "" });
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    listSessions(session.client, filters).then(
      (r) => live && setRows(r),
      () => live && setError("Sessions unavailable; reload."),
    );
    return () => {
      live = false;
    };
  }, [session.client, filters]);

  async function submit() {
    const scanned = parse(query.trim());
    if (scanned.ok && scanned.value.kind === "BOX") {
      const id = await sessionForBoxingToken(session.client, scanned.value.token).catch(() => null);
      setQuery("");
      if (id) router.push(`/allocate/${id}`);
      else setError("That boxing QR does not match a settlement.");
      return;
    }
    setError("");
    setFilters({ ...filters, q: query });
  }

  return (
    <section className="station-card" aria-label="Allocation sessions">
      <div className="intake-fields">
        <label>
          Search or scan a boxing QR
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="ALC-0001, party, angler, INT-0042"
          />
        </label>
        <button type="button" onClick={() => void submit()}>
          Search
        </button>
        <label>
          State
          <select
            value={filters.state}
            onChange={(e) =>
              setFilters({ ...filters, state: e.target.value as SessionFilters["state"] })
            }
          >
            <option value="open">Open (draft + priced)</option>
            <option value="">All</option>
            {Object.entries(SESSION_STATE_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fulfillment
          <select
            value={filters.fulfillment}
            onChange={(e) =>
              setFilters({
                ...filters,
                fulfillment: e.target.value as SessionFilters["fulfillment"],
              })
            }
          >
            <option value="">Any</option>
            {Object.entries(FULFILLMENT_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {!rows ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No sessions match.</p>
      ) : (
        <ul className="station-queue intake-list">
          {rows.map((r) => (
            <li key={r.session_id}>
              <Link href={`/allocate/${r.session_id}`}>{r.number}</Link>
              <span>{r.party_name}</span>
              <span className="station-badge">{SESSION_STATE_LABELS[r.state] ?? r.state}</span>
              <span className="station-badge">
                {FULFILLMENT_LABELS[r.fulfillment_status] ?? r.fulfillment_status}
                {r.box_count > 0 && ` · ${r.box_count - r.planned_count}/${r.box_count} boxes`}
              </span>
              <span>{r.intake_numbers.join(", ")}</span>
              <span>
                {r.settlement_count} angler{r.settlement_count === 1 ? "" : "s"}
                {r.paid_count > 0 && ` (${r.paid_count} paid)`}
              </span>
              {r.state !== "draft" && <span>{money(Number(r.amount_total))}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
