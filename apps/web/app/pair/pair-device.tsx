"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { normalisePairingCode, PAIRING_CODE_PATTERN } from "@/lib/pairing";
import { getDeviceClient } from "@/lib/supabase/device";

type PairResponse = {
  session?: { access_token: string; refresh_token: string };
  error?: string;
};

/** Exchanges a pairing code for the device's own session and stores it on this tablet. */
export function PairDevice({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const started = useRef(false);

  async function pair(raw: string) {
    const normalised = normalisePairingCode(raw);
    if (!PAIRING_CODE_PATTERN.test(normalised)) {
      setError("Codes are 8 letters and digits.");
      return;
    }
    setPending(true);
    setError(null);
    const client = getDeviceClient();
    const { data, error: invokeError } = await client.functions.invoke<PairResponse>(
      "device-pair",
      {
        body: { code: normalised },
      },
    );
    if (invokeError || !data?.session) {
      setPending(false);
      setError("That code is invalid or has expired. Ask a manager for a new one.");
      return;
    }
    const { error: sessionError } = await client.auth.setSession(data.session);
    if (sessionError) {
      setPending(false);
      setError("Pairing failed. Try again.");
      return;
    }
    router.replace("/device");
  }

  // A code in the QR URL pairs immediately.
  useEffect(() => {
    if (initialCode && !started.current) {
      started.current = true;
      void pair(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for the QR code
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void pair(code);
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-md flex-col gap-4 text-lg">
      <label className="flex flex-col gap-2 font-medium">
        Pairing code
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="h-16 rounded-md border-2 border-input px-4 font-mono text-3xl tracking-widest uppercase"
        />
      </label>
      {error ? (
        <p role="alert" className="text-xl text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-16 rounded-md bg-primary text-xl font-semibold text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Pairing…" : "Pair this tablet"}
      </button>
    </form>
  );
}
