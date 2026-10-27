import { webhookToken } from "shipping";

/**
 * The tracking-webhook URL a plant registers in ITS OWN Shippo account (docs/07 §4): carries the
 * org id and the org's derived token, never the platform secret. Server only (reads
 * SHIPPO_WEBHOOK_TOKEN). Null when webhooks are not configured on this server.
 */
export async function orgWebhookUrl(orgId: string): Promise<string | null> {
  const secret = process.env.SHIPPO_WEBHOOK_TOKEN;
  if (!secret) return null;
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  const token = await webhookToken(secret, orgId);
  return `${base}/api/shipping/webhook?org=${encodeURIComponent(orgId)}&token=${token}`;
}
