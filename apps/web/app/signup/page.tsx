import Link from "next/link";
import { SignupForm } from "./signup-form";

export default function SignupPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Set up your plant on Filletry</h1>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        Create an account, then name your plant. Species, processing rules and yields are filled in
        for you.
      </p>
      <SignupForm />
      <p className="text-sm">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
