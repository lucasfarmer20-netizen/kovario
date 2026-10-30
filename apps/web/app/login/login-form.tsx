"use client";

import Link from "next/link";
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
      <Link href="/forgot-password" className="-mt-2 self-end text-sm underline">
        Forgot password?
      </Link>
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
