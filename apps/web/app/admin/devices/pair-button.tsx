"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/form";
import { issuePairingCode, type PairingState } from "./actions";

/** Shows a fresh pairing QR + code for one device. Scan it with the tablet's camera. */
export function PairButton({ deviceId, paired }: { deviceId: string; paired: boolean }) {
  const [state, setState] = useState<PairingState | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={() => startTransition(async () => setState(await issuePairingCode(deviceId)))}
      >
        {paired ? "Re-pair" : "Pair"}
      </Button>
      {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state?.code && state.qrSvg ? (
        <div className="flex items-center gap-4 rounded-md border border-border p-3">
          {/* SVG generated server-side by the qrcode library from our own pairing URL. */}
          <div className="size-40" dangerouslySetInnerHTML={{ __html: state.qrSvg }} />
          <div className="flex flex-col gap-1 text-sm">
            <span>Scan with the tablet, or open /pair and type:</span>
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
