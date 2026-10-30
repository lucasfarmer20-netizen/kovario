import { NextResponse, type NextRequest } from "next/server";
import { defaultNext, emailLinkType, safeNextPath } from "@/lib/auth-redirect";
import { createSupabaseServer } from "@/lib/supabase/server";

/**
 * Landing route of every auth email (signup confirmation, password reset, invite, email
 * change). The templates in supabase/templates link here with `token_hash` + `type`
 * (verifyOtp, works on any device); Supabase's default links arrive with a PKCE `code`
 * (exchangeCodeForSession, same browser only). Either way the session lands in the cookie
 * and the user goes on to a same-origin `next`; a bad or used link goes to /login.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const type = emailLinkType(searchParams.get("type"));
  const tokenHash = searchParams.get("token_hash");
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"), origin, defaultNext(type));

  let signedIn = false;
  if (tokenHash && type) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    signedIn = !error;
  } else if (code) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    signedIn = !error;
  }
  // A relative Location keeps the browser on the host it came in on: Next rewrites
  // 127.0.0.1 to localhost in request URLs, which would strand the new session cookie.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: signedIn ? next : "/login?notice=link", "Cache-Control": "no-store" },
  });
}
