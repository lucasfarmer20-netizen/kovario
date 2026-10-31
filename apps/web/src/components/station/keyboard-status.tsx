import { FeedbackBanner } from "./scan-feedback";
import { StationNotice, type NoticeTone } from "./notice";

/** What a save or print on a keyboard station did: green (done) or red (why, then what to do). */
export type KeyboardFeedback = { ok: boolean; text: string; event: number };

/**
 * The status column of a keyboard station (`StationShell scanner={false}`: Intake, Storage
 * intake): the same fixed-height tile as a scan station's, saying what a save or print did. Idle,
 * it says the keyboard drives the form; a notice (offline, a refresh that failed) sits under it.
 */
export function KeyboardStatus({
  feedback,
  notice,
}: {
  feedback: KeyboardFeedback | null;
  notice?: { tone: NoticeTone; text: string } | null;
}) {
  return (
    <>
      {feedback ? (
        <FeedbackBanner
          tone={feedback.ok ? "ok" : "rejected"}
          text={feedback.text}
          event={feedback.event}
        />
      ) : (
        <FeedbackBanner tone="keyboard" text="Keyboard ready · Tab moves, Enter picks" />
      )}
      <StationNotice text={notice?.text ?? ""} tone={notice?.tone} />
    </>
  );
}
