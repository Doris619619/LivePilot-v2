import { service } from "@/server/service";
import { guard, failed } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { guard(request); return Response.json(await service().dashboard(), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return failed(e); }
}
