"use client";

import { useActionState } from "react";
import { Button, Input, Label } from "@/components/ui/form";
import { resetPassword } from "./actions";

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(resetPassword, {});
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-4">
      <Label>
        New password
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
      ) : null}
      <Button type="submit" disabled={pending}>
        Save and sign in
      </Button>
    </form>
  );
}
