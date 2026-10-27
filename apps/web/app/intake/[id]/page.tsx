import { notFound } from "next/navigation";
import { z } from "zod";
import { IntakeDetailStation } from "@/components/intake/intake-station";

export default async function IntakeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const { saved } = await searchParams;
  return <IntakeDetailStation intakeId={id.data} notice={saved?.slice(0, 200)} />;
}
