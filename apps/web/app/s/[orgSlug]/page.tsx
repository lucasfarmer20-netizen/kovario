import { StatusForm } from "./status-form";

export const metadata = { title: "Your fish · Filletry", robots: { index: false, follow: false } };

export default async function StatusPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6 py-12">
      <header>
        <p className="text-sm text-muted-foreground">Filletry · Customer status</p>
        <h1 className="mt-2 text-3xl font-semibold">How’s your fish coming along?</h1>
        <p className="mt-3">
          Enter the full phone number you gave us when you dropped off your fish.
        </p>
      </header>
      <StatusForm orgSlug={orgSlug} />
    </main>
  );
}
