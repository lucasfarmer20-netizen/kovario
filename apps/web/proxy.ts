import { serverClient } from "db";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "@/lib/supabase/env";

// Refreshes the staff session cookie on navigation so Server Components see a live
// token. Authorization happens in pages/actions (lib/auth.ts) and in RLS, not here.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = serverClient(supabaseEnv(), {
    getAll: () => request.cookies.getAll(),
    setAll: (list) => {
      for (const { name, value } of list) request.cookies.set(name, value);
      response = NextResponse.next({ request });
      for (const { name, value, options } of list) response.cookies.set(name, value, options);
    },
  });
  await supabase.auth.getClaims();
  return response;
}

export const config = {
  // Staff pages only; stations (/pair, /device) keep their own device session.
  matcher: ["/admin/:path*", "/reports/:path*", "/login", "/auth/:path*", "/signup", "/onboarding"],
};
