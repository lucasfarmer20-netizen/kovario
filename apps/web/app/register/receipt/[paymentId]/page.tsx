import { notFound } from "next/navigation";
import { z } from "zod";
import { PaymentReceiptStation } from "@/components/register/payment-receipt";

export default async function RegisterReceiptPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const id = z.uuid().safeParse((await params).paymentId);
  if (!id.success) notFound();
  return <PaymentReceiptStation paymentId={id.data} />;
}
