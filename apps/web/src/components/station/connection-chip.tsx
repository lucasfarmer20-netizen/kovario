"use client";
import { useSyncExternalStore } from "react";
import { CloudCheck, CloudOff, CloudUpload } from "lucide-react";

function subscribe(change: () => void) {
  window.addEventListener("online", change);
  window.addEventListener("offline", change);
  return () => {
    window.removeEventListener("online", change);
    window.removeEventListener("offline", change);
  };
}

/** navigator.onLine, live; true on the server. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * The scan queue's state in the console bar: "All sent", "3 pending" (saved on this device,
 * sending), or "Offline · 3 pending". Scans keep working offline; this says so plainly.
 */
export function ConnectionChip({ pending, online }: { pending: number; online: boolean }) {
  const tone = !online ? "offline" : pending > 0 ? "pending" : "ok";
  const Icon = !online ? CloudOff : pending > 0 ? CloudUpload : CloudCheck;
  return (
    <span className="station-badge" role="status" data-tone={tone}>
      <Icon size={20} aria-hidden />
      {!online && "Offline · "}
      {pending > 0 || !online ? `${pending} pending` : "All sent"}
    </span>
  );
}
