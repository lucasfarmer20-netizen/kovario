"use client";
import { StationsLink } from "@/src/components/station/stations-link";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStationSession, type StationSession } from "@/components/intake/use-station-session";
import { StorageDetail } from "./storage-detail";
import { StorageForm } from "./storage-form";
import { StorageQueue } from "./storage-queue";

function Shell({ session, children }: { session: StationSession | null; children: ReactNode }) {
  return (
    <main className="station intake-station storage-station">
      <header>
        <div>
          <p className="station-eyebrow">Filletry · {session?.siteName ?? "Storage"}</p>
          <h1>Cold storage</h1>
        </div>
        <nav className="station-actions" aria-label="Storage">
          <StationsLink />
          <Link href="/storage">New Storage</Link>
          <Link href="/storage/queue">Storage Queue</Link>
        </nav>
      </header>
      {children}
    </main>
  );
}

function WithSession({ children }: { children: (session: StationSession) => ReactNode }) {
  const { session, loaded } = useStationSession();
  if (!loaded) return <Shell session={null}>Opening storage…</Shell>;
  if (!session)
    return (
      <Shell session={null}>
        <p>Sign in as staff or pair this tablet as a station to take storage.</p>
        <div className="station-actions">
          <Link href="/login">Staff sign in</Link>
          <Link href="/pair">Pair device</Link>
        </div>
      </Shell>
    );
  return <Shell session={session}>{children(session)}</Shell>;
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
