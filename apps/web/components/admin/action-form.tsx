"use client";

import { useActionState, type ReactNode } from "react";
import type { ActionState } from "@/lib/admin-action";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/form";

/**
 * A form posting to an admin Server Action with a `client_action_id` (AGENTS.md hard rule 3).
 * `actionId` is minted per server render, so a double submit replays instead of repeating.
 */
export function ActionForm({
  action,
  actionId,
  submitLabel,
  className,
  children,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  actionId: string;
  submitLabel: string;
  className?: string;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className={cn("flex flex-wrap items-end gap-2", className)}>
      <input type="hidden" name="client_action_id" value={actionId} />
      {children}
      <Button type="submit" disabled={pending} variant="secondary">
        {submitLabel}
      </Button>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      ) : state.ok ? (
        <p aria-live="polite" className="w-full text-sm text-muted-foreground">
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
