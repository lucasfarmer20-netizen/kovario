"use client";
import { useState, type ReactNode } from "react";
import { Delete, KeyRound, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { stationMessage } from "./messages";
export type PinResult = { ok: boolean; reason?: string };
type Props = { verify: (pin: string) => Promise<PinResult>; onClose: () => void };

/**
 * Operator / manager PIN (docs/06): a non-modal sheet (phone) or card (tablet) with a 64-px
 * keypad; no focus trap, so the scanner's hidden input keeps working behind it. The station
 * refuses actions until the PIN is accepted, so the overlay never needs to block.
 */
function PinOverlay({
  title,
  lead,
  icon,
  verify,
  onClose,
}: Props & { title: string; lead: string; icon: ReactNode }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section role="dialog" aria-modal="false" aria-label={title} className="station-overlay">
      <div className="station-overlay-head">
        <span className="station-overlay-icon" aria-hidden="true">
          {icon}
        </span>
        <h2>{title}</h2>
      </div>
      <p className="station-overlay-lead">{lead}</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const result = await verify(pin);
            setPin("");
            if (result.ok) onClose();
            else setError(stationMessage(result.reason ?? "PIN rejected"));
          } catch {
            setError("Unable to verify PIN. Try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          PIN
          <input
            aria-label={`${title} PIN`}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]{4,6}"
            minLength={4}
            maxLength={6}
            required
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          />
        </label>
        <div className="station-keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "Clear", "0", "⌫"].map((key) => (
            <button
              type="button"
              key={key}
              disabled={busy}
              className={cn(
                key === "Clear" && "station-key-soft",
                key === "⌫" && "station-key-soft",
              )}
              aria-label={key === "⌫" ? "⌫" : undefined}
              onClick={() =>
                setPin((value) =>
                  key === "Clear"
                    ? ""
                    : key === "⌫"
                      ? value.slice(0, -1)
                      : (value + key).slice(0, 6),
                )
              }
            >
              {key === "⌫" ? <Delete aria-hidden="true" /> : key}
            </button>
          ))}
        </div>
        <div className="station-overlay-actions">
          <button disabled={busy} type="submit" className="sbtn sbtn-primary sbtn-lg">
            {busy ? "Checking…" : "Continue"}
          </button>
          <button type="button" onClick={onClose} className="sbtn sbtn-secondary sbtn-lg">
            Close
          </button>
        </div>
        <p role="alert">{error}</p>
      </form>
    </section>
  );
}
export function OperatorPinOverlay(props: Props) {
  return (
    <PinOverlay
      {...props}
      title="Operator PIN"
      lead="Enter your 4–6 digit PIN to keep scanning as yourself."
      icon={<KeyRound />}
    />
  );
}
export function ManagerPinOverlay(props: Props) {
  return (
    <PinOverlay
      {...props}
      title="Manager PIN"
      lead="A manager's 4–6 digit PIN approves this action."
      icon={<ShieldCheck />}
    />
  );
}
