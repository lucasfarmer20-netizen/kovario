"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { readPairingInput } from "@/lib/pairing";
import { getDeviceClient } from "@/lib/supabase/device";

type PairResponse = {
  session?: { access_token: string; refresh_token: string };
  error?: string;
};

/**
 * Exchanges a pairing code for the device's own session and stores it on this tablet.
 * The input stays focused for the station scanner, which types the admin page's
 * `FL:PAIR:<code>` QR followed by Enter; a person can type the bare code instead.
 */
export function PairDevice({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const started = useRef(false);

  async function pair(raw: string) {
    const normalised = readPairingInput(raw);
    if (normalised === null) {
      setError("That is not a pairing code. Scan the pairing QR or type its 8 characters.");
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

  // A code passed in the link (/pair?code=…) pairs immediately.
  useEffect(() => {
    if (initialCode && !started.current) {
      started.current = true;
      void pair(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for the linked code
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void pair(code);
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-md flex-col gap-4 text-lg">
      <label className="flex flex-col gap-2 font-medium">
        Scan the pairing QR or type the code
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
