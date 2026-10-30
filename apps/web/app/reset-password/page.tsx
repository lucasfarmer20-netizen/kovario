import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";

/** Reached from a reset email through /auth/confirm, which has already signed the user in. */
export default async function ResetPasswordPage() {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getClaims();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      {data ? (
        <ResetPasswordForm />
      ) : (
        <p className="max-w-sm text-center text-sm">
          This reset link is invalid or has expired.{" "}
          <Link href="/forgot-password" className="underline">
            Ask for a new link
          </Link>
          .
        </p>
      )}
    </main>
  );
}
