/** 读取当前账号的安全授权结果，引用不替代账号及设备权限。 */
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readOAuthResult } from "@/server/oauth-result";
export const runtime="nodejs";
/** 只读结果不会再次交换授权码或发起频道控制。 */
export async function GET(request:Request){try{guard(request);return Response.json(await readOAuthResult(new URL(request.url).searchParams.get("id")||"",await authenticate(request)),{headers:{"Cache-Control":"no-store"}});}catch(e){return failed(e);}}
