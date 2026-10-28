import { notFound } from "next/navigation";
import { z } from "zod";
import { IntakeReceipt } from "@/components/intake/intake-receipt";

export default async function IntakeReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  return <IntakeReceipt intakeId={id.data} />;
}
