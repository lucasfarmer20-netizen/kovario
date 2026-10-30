import Link from "next/link";
import { loginNotice } from "@/lib/auth-messages";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const notice = loginNotice((await searchParams).notice);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Sign in to Filletry</h1>
      {notice ? (
        <p role="status" className="max-w-sm text-center text-sm">
          {notice}
        </p>
      ) : null}
      <LoginForm />
      <p className="text-sm">
        New plant?{" "}
        <Link href="/signup" className="underline">
          Create an account
        </Link>
      </p>
    </main>
  );
}
