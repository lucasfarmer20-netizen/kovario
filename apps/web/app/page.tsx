import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">Filletry</h1>
      <p className="text-muted-foreground">Processing stations for sport-caught fish.</p>
      <p className="flex gap-4 text-sm">
        <Link href="/login" className="underline">
          Sign in
        </Link>
        <Link href="/signup" className="underline">
          Set up your plant
        </Link>
      </p>
    </main>
  );
}
