"use client";

import { useActionState } from "react";
import { Button, Input, Label } from "@/components/ui/form";
import { signIn } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, {});
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-4">
      <Label>
        Email
        <Input type="email" name="email" autoComplete="email" required />
      </Label>
      <Label>
        Password
        <Input type="password" name="password" autoComplete="current-password" required />
      </Label>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        Sign in
      </Button>
    </form>
  );
}
