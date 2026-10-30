"use client";

import { useActionState } from "react";
import { Button, Input, Label } from "@/components/ui/form";
import { requestPasswordReset } from "./actions";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordReset, {});
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-4">
      <Label>
        Email
        <Input type="email" name="email" autoComplete="email" required />
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
        Send reset link
      </Button>
    </form>
  );
}
