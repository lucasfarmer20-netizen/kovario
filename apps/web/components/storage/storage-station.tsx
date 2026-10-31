"use client";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { SignInNeeded } from "@/components/intake/intake-view";
import { KeyboardStatus } from "@/src/components/station/keyboard-status";
import { StorageDetail } from "./storage-detail";
import { StorageForm } from "./storage-form";
import { StorageQueue } from "./storage-queue";
import { STORAGE_STEPS, StorageShell, StorageSkeleton } from "./storage-view";

/**
 * The desk's session first: placeholders while it is read, and, with no session, the Cold
 * storage console asking who is at the desk (sign in or pair). Each screen renders its own console.
 */
function WithSession({ children }: { children: (session: StationSession) => ReactNode }) {
  const { session, loaded } = useStationSession();
  if (session) return <>{children(session)}</>;
  return (
    <StorageShell
      site="Storage"
      operator={null}
      prompt={
        loaded
          ? { next: "Sign in or pair this tablet", step: 0 }
          : { next: "Opening storage", step: 0 }
      }
      steps={STORAGE_STEPS}
      status={<KeyboardStatus feedback={null} />}
    >
      {loaded ? <SignInNeeded what="take storage" /> : <StorageSkeleton />}
    </StorageShell>
  );
}

/** /storage: a new storage intake; confirming opens it with the print notice. */
export function NewStorageStation() {
  const router = useRouter();
  return (
    <WithSession>
      {(session) => (
        <StorageForm
          session={session}
          onConfirmed={(r, labels) => {
            const notice =
              "error" in labels
                ? `${r.number} stored, but the labels did not queue (${labels.error}). Use Reprint Labels.`
                : labels.printer_missing
                  ? `${r.number} stored. No label printer is set up for this site.`
                  : `${r.number} stored; ${labels.label_jobs_queued} box labels queued.`;
            router.push(`/storage/${r.storage_intake_id}?saved=${encodeURIComponent(notice)}`);
          }}
        />
      )}
    </WithSession>
  );
}

export function StorageDetailStation({
  storageIntakeId,
  notice,
}: {
  storageIntakeId: string;
  notice?: string;
}) {
  return (
    <WithSession>
      {(session) => (
        <StorageDetail session={session} storageIntakeId={storageIntakeId} notice={notice} />
      )}
    </WithSession>
  );
}

export function StorageQueueStation() {
  return <WithSession>{(session) => <StorageQueue session={session} />}</WithSession>;
}
