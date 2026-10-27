// Shared plumbing for the /api/shipping/* route handlers (docs/07-INTEGRATIONS.md §4): body
// validation (zod), the caller's session (a paired station's bearer token, else the staff
// cookie), the service-role client, the org's Shippo client, and error → HTTP mapping.
//
// The service-role client is created HERE ONLY (AGENTS.md hard rule 1; listed in docs/07 §4):
// it reads the org's Shippo key from Vault and records provider results. Never import this
// module from a page, a component or a server action.
import { createClient } from "@supabase/supabase-js";
import type { Database, FilletryClient, Json } from "db";
import { shippoClient } from "shipping";
import { z } from "zod";
import { supabaseEnv } from "@/lib/supabase/env";
import { createSupabaseServer } from "@/lib/supabase/server";
import { ShippingRequestError, type ShippingDeps } from "./service";

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

function serviceClient(): FilletryClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key)
    throw new ShippingRequestError(
      "Shipping is not configured on this server",
      503,
      "not_configured",
    );
  return createClient<Database>(supabaseEnv().url, key, noSession);
}

/** The caller's client and, for a bearer caller, its JWT (getClaims has no stored session to read). */
async function callerFor(req: Request): Promise<{ client: FilletryClient; jwt?: string }> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return { client: await createSupabaseServer() };
  const env = supabaseEnv();
  const client = createClient<Database>(env.url, env.anonKey, {
    ...noSession,
    global: { headers: { Authorization: header } },
  });
  return { client, jwt: header.slice(7) };
}

const id = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const dim = z.number().finite().positive().max(999);

export const shipmentInput = z.object({ shipmentId: id });

export const buyInput = z.object({
  clientActionId: z.string().trim().min(8).max(200),
  shipmentId: id,
  forceBuyHeld: z.boolean().optional(),
  elevationToken: z.string().max(200).nullish(),
});

export const addressInput = z.object({
  name: text(200).min(1),
  company: text(200).optional(),
  street1: text(200).min(1),
  street2: text(200).optional(),
  city: text(200).min(1),
  state: text(40).min(1),
  zip: text(20).min(1),
  country: text(2).default("US"),
  phone: text(40).optional(),
  email: text(200).optional(),
});

export const rateCheckInput = z.object({
  to: addressInput,
  parcels: z
    .array(
      z.object({
        length_in: dim,
        width_in: dim,
        height_in: dim,
        weight_lb: dim,
        dry_ice_lb: z.number().finite().min(0).max(999).default(0),
      }),
    )
    .min(1)
    .max(20),
  bypassAllowlist: z.boolean().default(true),
});

export type MakeDeps = (req: Request) => Promise<ShippingDeps>;

/** Production dependencies: the caller's session (org from its verified claims), service role, Shippo. */
export const defaultDeps: MakeDeps = async (req) => {
  const { client: caller, jwt } = await callerFor(req);
  const { data, error } = await caller.auth.getClaims(jwt);
  const orgId = typeof data?.claims.org_id === "string" ? data.claims.org_id : null;
  if (error || !data || !orgId) throw new ShippingRequestError("Sign in first", 401);
  const deviceId = typeof data.claims.device_id === "string" ? data.claims.device_id : null;
  return {
    caller,
    service: serviceClient(),
    orgId,
    deviceId,
    shippoFor: (apiKey) => shippoClient({ apiKey }),
  };
};

/** A POST handler: validate the body, build the deps, run, map errors to statuses. */
export function shippingRoute<S extends z.ZodType>(
  schema: S,
  run: (deps: ShippingDeps, input: z.infer<S>) => Promise<unknown>,
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
      return Response.json((await run(await makeDeps(req), parsed.data)) as Json);
    } catch (e) {
      if (e instanceof ShippingRequestError) {
        return Response.json({ error: e.message, code: e.code }, { status: e.status });
      }
      // Unknown failures never echo internals (they may carry provider or config detail).
      return Response.json({ error: "Shipping request failed" }, { status: 500 });
    }
  };
}
