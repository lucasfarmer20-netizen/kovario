import { PairDevice } from "./pair-device";

export default async function PairPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">Pair station tablet</h1>
      <PairDevice initialCode={typeof code === "string" ? code : ""} />
    </main>
  );
}
