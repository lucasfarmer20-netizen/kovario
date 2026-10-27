import { notFound } from "next/navigation";
import { z } from "zod";
import { StorageDetailStation } from "@/components/storage/storage-station";

export default async function StorageDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const { saved } = await searchParams;
  return <StorageDetailStation storageIntakeId={id.data} notice={saved?.slice(0, 200)} />;
}
