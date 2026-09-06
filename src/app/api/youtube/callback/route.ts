import { NextRequest, NextResponse } from "next/server";
import { guard } from "@/server/http";
import { config } from "@/server/config";
import { service } from "@/server/service";
import { safeError } from "@/server/errors";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  let error: string | undefined;
  try {
    guard(request);
    const app = service();
    await app.control.exclusive(async () => {
      const state = await app.control.state();
      await app.auth.finish(request.cookies.get("livepilot_oauth")?.value || "", request.nextUrl.searchParams.get("state") || "", request.nextUrl.searchParams.get("code") || "", state.phase !== "stopped" ? state.channelId : undefined);
    });
    app.invalidate();
  } catch (e) { error = safeError(e); }
  const response = NextResponse.redirect(config().origin + (error ? "/?oauth=failed" : "/?oauth=connected"), 303);
  response.cookies.set("livepilot_oauth", "", { path: "/api/youtube", maxAge: 0, httpOnly: true, sameSite: "lax" });
  // Fixed error text only; never forward OAuth code, token or upstream error details.
  if (error) response.cookies.set("livepilot_notice", encodeURIComponent(error), { path: "/", maxAge: 120, sameSite: "strict" });
  return response;
}
