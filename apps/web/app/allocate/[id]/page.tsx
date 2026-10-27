import { notFound } from "next/navigation";
import { z } from "zod";
import { AllocationDetailStation } from "@/components/allocate/allocate-station";

export default async function AllocationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const { saved } = await searchParams;
  return <AllocationDetailStation sessionId={id.data} notice={saved?.slice(0, 200)} />;
}
