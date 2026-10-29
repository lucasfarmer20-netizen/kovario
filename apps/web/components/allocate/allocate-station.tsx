"use client";
import { StationsLink } from "@/src/components/station/stations-link";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CustomerSearch } from "@/components/customers/customer-search";
import type { CustomerHit } from "@/components/customers/customer-search-state";
import { createCustomer, searchCustomers } from "@/components/intake/intake-data";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { customerIntakes, loadDraft, loadSummary, type SessionSummary } from "./allocate-data";
import { newDraft, type PooledIntake, type SessionDraft } from "./allocate-state";
import { SessionEditor } from "./session-editor";
import { SessionList } from "./session-list";
import { SettlementReceiptView } from "./settlement-receipt";

function Shell({ session, children }: { session: StationSession | null; children: ReactNode }) {
  return (
    <main className="station intake-station allocate-station">
      <header>
        <div>
          <p className="station-eyebrow">Filletry · {session?.siteName ?? "Counter"}</p>
          <h1>Counter allocation</h1>
        </div>
        <nav className="station-actions" aria-label="Allocation">
          <StationsLink />
          <Link href="/allocate/new">New Session</Link>
          <Link href="/allocate">Sessions</Link>
        </nav>
      </header>
      {children}
    </main>
  );
}

function WithSession({ children }: { children: (session: StationSession) => ReactNode }) {
  const { session, loaded } = useStationSession();
  if (!loaded) return <Shell session={null}>Opening the counter…</Shell>;
  if (!session)
    return (
      <Shell session={null}>
        <p>Sign in as staff or pair this tablet as a station to allocate.</p>
        <div className="station-actions">
          <Link href="/login">Staff sign in</Link>
          <Link href="/pair">Pair device</Link>
        </div>
      </Shell>
    );
  return <Shell session={session}>{children(session)}</Shell>;
}

/** /allocate: the session list with filters. */
export function AllocateListStation() {
  return <WithSession>{(session) => <SessionList session={session} />}</WithSession>;
}

/** Customer → their open intakes (pick one or more) → the session editor. */
function NewSession({ session }: { session: StationSession }) {
  const router = useRouter();
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [intakes, setIntakes] = useState<PooledIntake[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<SessionDraft | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!customer) return;
    let live = true;
    customerIntakes(session.client, customer.id).then(
      (rows) => {
        if (!live) return;
        setIntakes(rows);
        setPicked(new Set(rows.map((r) => r.id)));
      },
      () => live && setError("Intakes unavailable; try again."),
    );
    return () => {
      live = false;
    };
  }, [session.client, customer]);

  if (draft)
    return (
      <SessionEditor
        session={session}
        initial={draft}
        summary={null}
        onSaved={(s) =>
          router.push(
            `/allocate/${s.session_id}?saved=${encodeURIComponent(`${s.number} ${s.state === "priced" ? "priced" : "saved"}.`)}`,
          )
        }
      />
    );

  return (
    <section className="station-card" aria-label="New allocation session">
      <h2>Who is the party?</h2>
      {customer ? (
        <div className="intake-customer">
          <strong>{customer.name}</strong>
          <button
            type="button"
            onClick={() => {
              setCustomer(null);
              setIntakes(null);
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <CustomerSearch
          autoFocus
          search={(q) => searchCustomers(session.client, session.claims.orgId, q)}
          create={(input) => createCustomer(session.client, input)}
          onSelect={setCustomer}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {intakes && (
        <>
          <h3>Intakes to pool</h3>
          {intakes.length === 0 ? (
            <p>No open intakes for this customer. Start anyway and add intakes by number.</p>
          ) : (
            <ul className="station-queue intake-list">
              {intakes.map((i) => (
                <li key={i.id}>
                  <label className="intake-toggle">
                    <input
                      type="checkbox"
                      checked={picked.has(i.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(i.id);
                        else next.delete(i.id);
                        setPicked(next);
                      }}
                    />
                    {i.number}
                  </label>
                  <span className="station-badge">{i.state}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="station-actions">
            <button
              type="button"
              onClick={() =>
                setDraft(
                  newDraft(
                    intakes.filter((i) => picked.has(i.id)),
                    customer ? { id: customer.id, name: customer.name } : null,
                  ),
                )
              }
            >
              Start session
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function NewAllocationStation() {
  return <WithSession>{(session) => <NewSession session={session} />}</WithSession>;
}

function LoadedSession({
  session,
  sessionId,
  notice,
}: {
  session: StationSession;
  sessionId: string;
  notice?: string;
}) {
  const [loaded, setLoaded] = useState<{ draft: SessionDraft; summary: SessionSummary } | null>(
    null,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([
      loadDraft(session.client, sessionId),
      loadSummary(session.client, sessionId),
    ]).then(
      ([draft, summary]) => live && setLoaded({ draft, summary }),
      () => live && setError("Session not found."),
    );
    return () => {
      live = false;
    };
  }, [session.client, sessionId]);
  if (error) return <p role="alert">{error}</p>;
  if (!loaded) return <p>Loading…</p>;
  return (
    <>
      {notice && (
        <p role="status" className="station-feedback station-ok">
          {notice}
        </p>
      )}
      <SessionEditor session={session} initial={loaded.draft} summary={loaded.summary} />
    </>
  );
}

export function AllocationDetailStation({
  sessionId,
  notice,
}: {
  sessionId: string;
  notice?: string;
}) {
  return (
    <WithSession>
      {(session) => <LoadedSession session={session} sessionId={sessionId} notice={notice} />}
    </WithSession>
  );
}

export function SettlementReceiptStation({ settlementId }: { settlementId: string }) {
  return (
    <WithSession>
      {(session) => <SettlementReceiptView session={session} settlementId={settlementId} />}
    </WithSession>
  );
}
