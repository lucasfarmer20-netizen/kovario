import { notFound } from "next/navigation";
import { z } from "zod";
import { SettlementReceiptStation } from "@/components/allocate/allocate-station";

export default async function SettlementReceiptPage({
  params,
}: {
  params: Promise<{ settlementId: string }>;
}) {
  const id = z.uuid().safeParse((await params).settlementId);
  if (!id.success) notFound();
  return <SettlementReceiptStation settlementId={id.data} />;
}
