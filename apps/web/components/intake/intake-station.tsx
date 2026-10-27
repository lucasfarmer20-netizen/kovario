"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IntakeDetail } from "./intake-detail";
import { IntakeForm } from "./intake-form";
import { IntakeList } from "./intake-list";
import { useStationSession, type StationSession } from "./use-station-session";

function Shell({ session, children }: { session: StationSession | null; children: ReactNode }) {
  return (
    <main className="station intake-station">
      <header>
        <div>
          <p className="station-eyebrow">Filletry · {session?.siteName ?? "Intake"}</p>
          <h1>Intake</h1>
        </div>
        <nav className="station-actions" aria-label="Intake">
          <Link href="/intake">New Intake</Link>
          <Link href="/intakes">Intakes</Link>
        </nav>
      </header>
      {children}
    </main>
  );
}

function WithSession({ children }: { children: (session: StationSession) => ReactNode }) {
  const { session, loaded } = useStationSession();
  if (!loaded) return <Shell session={null}>Opening intake…</Shell>;
  if (!session)
    return (
      <Shell session={null}>
        <p>Sign in as staff or pair this tablet as a station to take intakes.</p>
        <div className="station-actions">
          <Link href="/login">Staff sign in</Link>
          <Link href="/pair">Pair device</Link>
        </div>
      </Shell>
    );
  return <Shell session={session}>{children(session)}</Shell>;
}

/** /intake: a new intake; saving opens the saved view with its post-save header. */
export function NewIntakeStation() {
  const router = useRouter();
  return (
    <WithSession>
      {(session) => (
        <IntakeForm
          session={session}
          onSaved={(r) => {
            const notice = r.printer_missing
              ? `${r.number} saved. No tote printer is set up for this site.`
              : `${r.number} saved; ${r.tote_jobs_queued} tote tags queued.`;
            router.push(`/intake/${r.intake_id}?saved=${encodeURIComponent(notice)}`);
          }}
        />
      )}
    </WithSession>
  );
}

export function IntakeDetailStation({ intakeId, notice }: { intakeId: string; notice?: string }) {
  return (
    <WithSession>
      {(session) => <IntakeDetail session={session} intakeId={intakeId} notice={notice} />}
    </WithSession>
  );
}

export function IntakeListStation() {
  return <WithSession>{(session) => <IntakeList session={session} />}</WithSession>;
}
