import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        Enter the email you sign in with. We&apos;ll send a link to choose a new password.
      </p>
      <ForgotPasswordForm />
      <p className="text-sm">
        <Link href="/login" className="underline">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
