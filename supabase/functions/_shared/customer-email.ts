export type EmailKind = "intake_confirmation" | "ready_for_pickup" | "shipped";
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function customerEmail(input: { kind: EmailKind; orgName: string; slug: string; reference: string; pickupHours: string; notice: string; tracking: string | null }) {
  const titles: Record<EmailKind, string> = { intake_confirmation: "We’ve received your fish", ready_for_pickup: "Your fish is ready for pickup", shipped: "Your fish has shipped" };
  const subject = `${input.orgName.replace(/[\r\n]/g, " ")} · ${titles[input.kind]}`;
  const text = `${titles[input.kind]}\n${input.orgName}\n${input.reference}\n${input.kind === "shipped" ? `Tracking: ${input.tracking ?? "Contact the plant for tracking"}` : `Pickup hours: ${input.pickupHours || "Contact the plant"}`}\n${input.notice}\nhttps://app.filletry.com/s/${input.slug}`;
  return { subject, text, html: `<main><h1>${escape(input.orgName)}</h1>${text.split("\n").map(line => `<p>${escape(line)}</p>`).join("")}</main>` };
}

/** Provider bodies can contain addresses or credentials: retain only HTTP status. */
export function scrubEmailError(status: number): string { return `resend_http_${status}`; }

export async function deliverCustomerEmail(payload: unknown, key: string, id: string, request: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await request("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `customer-email/${id}` },
      body: JSON.stringify(payload),
    });
    return response.ok ? null : scrubEmailError(response.status);
  } catch { return "email_transport_failed"; }
}
