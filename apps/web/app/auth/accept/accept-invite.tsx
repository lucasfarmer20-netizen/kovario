"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, Label } from "@/components/ui/form";
import { getBrowserClient } from "@/lib/supabase/browser";

/**
 * Landing page of an invite email; asks the new member for a password. The invite template
 * (supabase/templates/invite.html) goes through /auth/confirm, which has already put the
 * session in the cookie; Supabase's default invite link redirects here with the session in
 * the URL fragment instead, which we store in the cookie session.
 */
export function AcceptInvite() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    window.history.replaceState(null, "", window.location.pathname);
    const accepted =
      accessToken && refreshToken
        ? getBrowserClient()
            .auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
            .then(({ error: sessionError }) => !sessionError)
        : getBrowserClient()
            .auth.getUser()
            .then(({ data }) => !!data.user);
    void accepted.then((ok) => {
      if (ok) setReady(true);
      else
        setError(params.get("error_description") ?? "This invite link is invalid or has expired.");
    });
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    setPending(true);
    const { error: updateError } = await getBrowserClient().auth.updateUser({ password });
    setPending(false);
    if (updateError) setError(updateError.message);
    else router.replace("/stations");
  }

  if (error && !ready) return <p className="text-destructive">{error}</p>;
  if (!ready) return <p className="text-muted-foreground">Checking your invite…</p>;
  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      <Label>
        Choose a password
        <Input type="password" name="password" autoComplete="new-password" required minLength={8} />
      </Label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        Save and continue
      </Button>
    </form>
  );
}
