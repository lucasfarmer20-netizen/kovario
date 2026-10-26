import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Sign in to Kovario</h1>
      <LoginForm />
    </main>
  );
}
