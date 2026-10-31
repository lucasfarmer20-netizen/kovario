"use client";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { KeyboardStatus } from "@/src/components/station/keyboard-status";
import { IntakeDetail } from "./intake-detail";
import { IntakeForm } from "./intake-form";
import { IntakeList } from "./intake-list";
import { IntakeFormSkeleton, IntakeShell, SignInNeeded } from "./intake-view";
import { useStationSession, type StationSession } from "./use-station-session";

/**
 * The desk's session first: placeholders while it is read, and, with no session, the Intake
 * console asking who is at the desk (sign in or pair). Each screen renders its own console.
 */
function WithSession({ children }: { children: (session: StationSession) => ReactNode }) {
  const { session, loaded } = useStationSession();
  if (session) return <>{children(session)}</>;
  return (
    <IntakeShell
      site="Intake"
      operator={null}
      prompt={
        loaded
          ? { next: "Sign in or pair this tablet", step: 0 }
          : { next: "Opening the order form", step: 0 }
      }
      status={<KeyboardStatus feedback={null} />}
    >
      {loaded ? <SignInNeeded what="take orders" /> : <IntakeFormSkeleton />}
    </IntakeShell>
  );
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
