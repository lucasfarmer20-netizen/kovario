"use client";
import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { stationMessage } from "./messages";
import type { ScanReply } from "./scan-queue";

/**
 * Accept / reject feedback for a scan (docs/06): the strip fills green or red with an icon and
 * the reason for 3 s, with a flash on every event (keyed, so two scans in a row both flash) and
 * one beep or a double buzz. The strip keeps its height while idle so nothing below it moves.
 */
export function ScanFeedback({
  feedback,
  persist = false,
}: {
  feedback: (ScanReply & { event: number }) | null;
  /** Keep the strip up (the gallery); the station lets it clear after 3 s. */
  persist?: boolean;
}) {
  const audio = useRef<AudioContext | null>(null);
  const [expiredEvent, setExpiredEvent] = useState<number | null>(null);
  const visible = feedback !== null && feedback.event !== expiredEvent;
  useEffect(() => {
    const unlock = () => {
      audio.current ??= new AudioContext();
      void audio.current.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      void audio.current?.close();
      audio.current = null;
    };
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const context = audio.current;
    if (context?.state === "running") {
      for (let i = 0; i < (feedback.ok ? 1 : 2); i++) {
        const tone = context.createOscillator();
        const volume = context.createGain();
        tone.type = feedback.ok ? "sine" : "square";
        tone.frequency.value = feedback.ok ? 880 : 150;
        volume.gain.value = 0.12;
        tone.connect(volume);
        volume.connect(context.destination);
        tone.start(context.currentTime + i * 0.18);
        tone.stop(context.currentTime + i * 0.18 + 0.12);
        tone.onended = () => {
          tone.disconnect();
          volume.disconnect();
        };
      }
    }
    if (persist) return;
    const timer = setTimeout(() => setExpiredEvent(feedback.event), 3000);
    return () => clearTimeout(timer);
  }, [feedback, persist]);
  const shown = visible && feedback ? feedback : null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("station-feedback", shown && (shown.ok ? "station-ok" : "station-rejected"))}
    >
      {shown && (
        <>
          <span key={shown.event} className="station-feedback-flash" aria-hidden="true" />
          <span className="station-feedback-icon" aria-hidden="true">
            {shown.ok ? <Check /> : <X />}
          </span>
          <span>
            <span className="sr-only">{shown.ok ? "Accepted: " : "Rejected: "}</span>
            {stationMessage(shown.reason)}
          </span>
        </>
      )}
    </div>
  );
}
