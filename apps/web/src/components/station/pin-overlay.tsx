"use client";
import { useState } from "react";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { stationMessage } from "./messages";
export type PinResult = { ok: boolean; reason?: string };
type Props = { verify: (pin: string) => Promise<PinResult>; onClose: () => void };
function PinOverlay({ title, verify, onClose }: Props & { title: string }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section role="dialog" aria-modal="false" aria-label={title} className="station-overlay">
      <h2>
        {title === "Manager PIN" ? (
          <ShieldCheck size={28} aria-hidden />
        ) : (
          <KeyRound size={28} aria-hidden />
        )}
        {title}
      </h2>
      <p>Enter your 4–6 digit PIN</p>
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
          PIN{" "}
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
              {key}
            </button>
          ))}
        </div>
        <div className="st-overlay-actions">
          <button disabled={busy} type="submit" className="st-btn-hero">
            {busy && <LoaderCircle className="st-spin" size={24} aria-hidden />}
            {busy ? "Checking…" : "Continue"}
          </button>
          <button type="button" className="st-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <p role="alert">{error}</p>
      </form>
    </section>
  );
}
export function OperatorPinOverlay(props: Props) {
  return <PinOverlay {...props} title="Operator PIN" />;
}
export function ManagerPinOverlay(props: Props) {
  return <PinOverlay {...props} title="Manager PIN" />;
}
