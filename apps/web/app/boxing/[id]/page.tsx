import { notFound } from "next/navigation";
import { z } from "zod";
import { BoxingStation } from "@/components/boxing/boxing-station";

export default async function BoxingPartyPage({ params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  return <BoxingStation sessionId={id.data} />;
}
