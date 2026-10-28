// Shared plumbing for the /api/payments/* route handlers: body validation (zod), the caller's
// session (a bearer token — a paired station keeps its session in localStorage — else the staff
// cookie), the service-role client, the provider registry, and error → HTTP mapping.
import type { FilletryClient, Json } from "db";
import { providerFor } from "payments";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { bearerClient, serviceRoleClient } from "@/lib/supabase/service";
import { PaymentRequestError, type PaymentsDeps } from "./service";

const id = z.string().uuid();
const clientActionId = z.string().trim().min(8).max(200);
const money = z.number().finite().nonnegative().max(1_000_000);
const optionalText = z.string().trim().max(500).nullish();

export const saleInput = z.object({
  clientActionId,
  orderId: id,
  amount: money,
  terminalId: id.nullish(),
  tender: z.enum(["card", "cash", "check", "external", "comp"]),
  tenderRef: optionalText,
  reason: optionalText,
  elevationToken: z.string().max(200).nullish(),
});

export const paymentInput = z.object({ paymentId: id });

export const reverseInput = z.object({
  clientActionId,
  paymentId: id,
  reason: z.string().trim().min(1).max(500),
  elevationToken: z.string().max(200).nullish(),
});

export const refundInput = reverseInput.extend({ amount: money.positive() });

export type MakeDeps = (req: Request) => Promise<PaymentsDeps>;

async function callerFor(req: Request): Promise<{ caller: FilletryClient; jwt?: string }> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return { caller: await createSupabaseServer() };
  const jwt = header.slice(7);
  return { caller: bearerClient(jwt), jwt };
}

/** Production dependencies: the caller's session, the service role and the provider registry. */
export const defaultDeps: MakeDeps = async (req) => {
  const { caller, jwt } = await callerFor(req);
  // A bearer client holds no session of its own: verify the token it was given.
  const { data, error } = await caller.auth.getClaims(jwt);
  if (error || !data) throw new PaymentRequestError("Sign in first", 401);
  return { caller, service: serviceRoleClient(), providerFor };
};

/** A POST handler: validate the body, build the deps, run, map errors to statuses. */
export function paymentsRoute<S extends z.ZodType>(
  schema: S,
  run: (deps: PaymentsDeps, input: z.infer<S>) => Promise<Json>,
  makeDeps: MakeDeps = defaultDeps,
): (req: Request) => Promise<Response> {
  return async (req) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Send a JSON body" }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request", issues: z.flattenError(parsed.error).fieldErrors },
        { status: 400 },
      );
    }
    try {
      return Response.json(await run(await makeDeps(req), parsed.data));
    } catch (e) {
      if (e instanceof PaymentRequestError) {
        return Response.json({ error: e.message, code: e.code ?? null }, { status: e.status });
      }
      // Unknown failures never echo internals (they may carry provider or config detail).
      return Response.json(
        { error: "The payment request failed; check the payment's status." },
        { status: 500 },
      );
    }
  };
}
