"use client";
import { useEffect, useState } from "react";
import type { FilletryClient } from "db";
export type QueueItem = { id: string; label: string; enteredAt: string; detail?: string };
export function ageBadge(enteredAt: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(enteredAt)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}
export function useRealtimeQueue(client: FilletryClient, orgId: string, refresh: () => void) {
  useEffect(() => {
    refresh();
    const channel = client
      .channel(`station-queue:${orgId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "intake", filter: `org_id=eq.${orgId}` },
        refresh,
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") refresh();
      });
    // Poll as a fallback when Realtime disconnects.
    const timer = setInterval(refresh, 30_000);
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [client, orgId, refresh]);
}
export function QueueList({
  items,
  title = "Next up",
  ageLabel = "in cooler",
}: {
  items: QueueItem[];
  title?: string;
  ageLabel?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="station-queue">
      <h2>{title}</h2>
      <ol>
        {[...items]
          .sort(
            (a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt) || a.id.localeCompare(b.id),
          )
          .map((item) => (
            <li key={item.id}>
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
              <span className="station-badge">
                {ageBadge(item.enteredAt, now)} {ageLabel}
              </span>
            </li>
          ))}
      </ol>
      {!items.length && <p>Queue is clear</p>}
    </section>
  );
}
