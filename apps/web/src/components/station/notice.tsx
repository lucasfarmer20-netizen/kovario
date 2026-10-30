import { CircleCheck, Info, OctagonAlert } from "lucide-react";

export type NoticeTone = "ok" | "error" | "info";

/**
 * A station's reply to a tap (weight saved, refused, sign-off done) under the scan tile, in
 * the docs/11 grammar: what happened, then what to do. Always mounted, so it is announced.
 */
export function StationNotice({ text, tone = "info" }: { text: string; tone?: NoticeTone }) {
  const Icon = tone === "ok" ? CircleCheck : tone === "error" ? OctagonAlert : Info;
  return (
    <p role="status" className="st-notice" data-tone={tone}>
      {text && (
        <>
          <Icon size={20} aria-hidden />
          <span>{text}</span>
        </>
      )}
    </p>
  );
}
