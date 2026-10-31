"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Keyboard, ScanLine, X } from "lucide-react";
import { stationMessage } from "./messages";
import { useShownScannerPaused } from "./scanner-context";
import type { ScanReply } from "./scan-queue";

/** "keyboard": the idle tile of a keyboard station (no scanner): what typing does. */
export type FeedbackTone = "ok" | "rejected" | "idle" | "paused" | "keyboard";

/**
 * The scan tile: one fixed-height place for what the last scan did. Accepted is green with a
 * check and a short pop; rejected is red with a cross and a shake (both read without colour:
 * icon + words). Between scans it says whether the scanner is listening, so the operator never
 * wonders if a scan will land. Presentational; `ScanFeedback` drives it from scan replies.
 */
export function FeedbackBanner({
  tone,
  text,
  event,
}: {
  tone: FeedbackTone | null;
  text: string;
  /** Changes on every scan, so the same message twice still animates. */
  event?: number;
}) {
  const live = tone === "ok" || tone === "rejected";
  return (
    <div
      role="status"
      aria-live="polite"
      data-tone={tone ?? undefined}
      className={`station-feedback ${tone === "ok" ? "station-ok" : tone === "rejected" ? "station-rejected" : ""}`}
    >
      {tone && (
        <span key={live ? event : tone} className="st-feedback-body">
          <span className="st-feedback-icon" aria-hidden>
            {tone === "ok" ? (
              <Check size={30} strokeWidth={3.2} />
            ) : tone === "rejected" ? (
              <X size={30} strokeWidth={3.2} />
            ) : tone === "paused" || tone === "keyboard" ? (
              <Keyboard size={22} />
            ) : (
              <ScanLine size={22} />
            )}
          </span>
          {tone === "idle" && <span className="st-pulse" aria-hidden />}
          <span>
            {/* The glyph stays in the text, "✓ …" / "✕ …", as before the icons (e2e reads it). */}
            {live && <span className="st-sr">{tone === "ok" ? "✓ " : "✕ "}</span>}
            {text}
          </span>
        </span>
      )}
    </div>
  );
}

export function ScanFeedback({
  feedback,
  idle,
}: {
  feedback: (ScanReply & { event: number }) | null;
  /** Between scans, say whether the scanner is listening ("Scanner ready"). Omitted: empty. */
  idle?: boolean;
}) {
  const paused = useShownScannerPaused();
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
    const timer = setTimeout(() => setExpiredEvent(feedback.event), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);
  if (visible && feedback)
    return (
      <FeedbackBanner
        tone={feedback.ok ? "ok" : "rejected"}
        text={stationMessage(feedback.reason)}
        event={feedback.event}
      />
    );
  if (idle)
    return (
      <FeedbackBanner
        tone={paused ? "paused" : "idle"}
        text={paused ? "Scanner paused while a field is open" : "Scanner ready"}
      />
    );
  return <FeedbackBanner tone={null} text="" />;
}
