"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, Input, Label } from "@/components/ui/form";
import { signUp } from "./actions";

/**
 * Shown for a new email and for one that already has an account alike (no account check,
 * #116): whoever already has one gets the way back in instead of waiting for an email.
 */
export function SignupSent({ message }: { message: string }) {
  return (
    <div aria-live="polite" className="flex flex-col gap-1 text-sm">
      <p>{message}</p>
      <p>
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>{" "}
        or{" "}
        <Link href="/forgot-password" className="underline">
          reset your password
        </Link>
        .
      </p>
    </div>
  );
}

export function SignupForm() {
  const [state, action, pending] = useActionState(signUp, {});
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-4">
      <Label>
        Email
        <Input type="email" name="email" autoComplete="email" required />
      </Label>
      <Label>
        Password
        <Input
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={72}
          required
        />
      </Label>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : state.ok ? (
        <SignupSent message={state.ok} />
      ) : null}
      <Button type="submit" disabled={pending}>
        Create account
      </Button>
    </form>
  );
}
