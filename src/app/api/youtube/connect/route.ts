import { NextResponse } from "next/server";
import { guard, failed } from "@/server/http";
import { service } from "@/server/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    guard(request, true);
    const app = service();
    const result = await app.control.exclusive(() => app.auth.begin());
    const response = NextResponse.json({ url: result.url });
    response.cookies.set("livepilot_oauth", result.cookie, { httpOnly: true, sameSite: "lax", secure: false, path: "/api/youtube", maxAge: 600 });
    return response;
  } catch (e) { return failed(e); }
}
