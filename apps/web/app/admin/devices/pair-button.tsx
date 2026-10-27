"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/form";
import { issuePairingCode, type PairingState } from "./actions";

/**
 * Shows a pairing QR + code for one device. The tablet opens /pair and scans the QR with its
 * station scanner (or someone types the code).
 * One click intent keeps one client_action_id until a code is shown, so a double click or
 * a retry after an error replays the same code instead of replacing it; only the response
 * to the latest intent is displayed.
 */
export function PairButton({ deviceId, paired }: { deviceId: string; paired: boolean }) {
  const [state, setState] = useState<PairingState | null>(null);
  const [pending, startTransition] = useTransition();
  const intentId = useRef<string | null>(null);
  const latestId = useRef<string | null>(null);

  function issue() {
    intentId.current ??= crypto.randomUUID();
    const id = intentId.current;
    latestId.current = id;
    startTransition(async () => {
      const result = await issuePairingCode(deviceId, id);
      if (latestId.current !== id) return; // a newer request owns the display
      setState(result);
      if (!result.error) intentId.current = null; // next click issues a fresh code
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button type="button" variant="secondary" disabled={pending} onClick={issue}>
        {paired ? "Re-pair" : "Pair"}
      </Button>
      {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state?.active === false ? (
        <p className="text-sm text-muted-foreground">
          That code was replaced or already used. Press “{paired ? "Re-pair" : "Pair"}” for a new
          one.
        </p>
      ) : null}
      {state?.active && state.code && state.qrSvg ? (
        <div className="flex items-center gap-4 rounded-md border border-border p-3">
          {/* SVG rendered server-side from the FL:PAIR text produced by packages/rules qr.ts. */}
          <div className="size-40" dangerouslySetInnerHTML={{ __html: state.qrSvg }} />
          <div className="flex flex-col gap-1 text-sm">
            <span>On the tablet open /pair, then scan this QR or type:</span>
            <span className="font-mono text-2xl tracking-widest">{state.code}</span>
            <span className="text-muted-foreground">
              Expires {state.expiresAt ? new Date(state.expiresAt).toLocaleTimeString() : "soon"} ·
              single use
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
