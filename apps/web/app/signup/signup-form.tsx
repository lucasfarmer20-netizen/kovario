"use client";

import { useActionState } from "react";
import { Button, Input, Label } from "@/components/ui/form";
import { signUp } from "./actions";

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
        <Input type="password" name="password" autoComplete="new-password" minLength={8} required />
      </Label>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : state.ok ? (
        <p aria-live="polite" className="text-sm">
          {state.ok}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        Create account
      </Button>
    </form>
  );
}
