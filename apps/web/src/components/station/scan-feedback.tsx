"use client";
import { useEffect, useRef, useState } from "react";
import { stationMessage } from "./messages";
import type { ScanReply } from "./scan-queue";

export function ScanFeedback({ feedback }: { feedback: (ScanReply & { event: number }) | null }) {
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
  return (
    <div
      role="status"
      aria-live="polite"
      className={`station-feedback ${visible && feedback ? (feedback.ok ? "station-ok" : "station-rejected") : ""}`}
    >
      {visible && feedback ? `${feedback.ok ? "✓" : "✕"} ${stationMessage(feedback.reason)}` : ""}
    </div>
  );
}
