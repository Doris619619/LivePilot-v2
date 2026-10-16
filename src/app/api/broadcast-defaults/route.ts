/** 按当前登录账号存储新直播默认值；修订号防止多窗口互相覆盖。 */
import path from "node:path";
import { createHash } from "node:crypto";
import { authenticate, type Member } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { Store } from "@/core/storage";
import { dataRoot } from "@/core/config";
import { AppError } from "@/core/errors";
import { transaction } from "@/cloud/store";
import { broadcastDefaultsRecordSchema, initialBroadcastDefaults } from "@/shared/broadcast-options";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 账号路径只由鉴权身份派生，不接受浏览器指定其他用户。 */
function storage(user: Member) { return new Store(path.join(dataRoot(), "broadcast-defaults", createHash("sha256").update(user.username).digest("hex"))); }
/** 损坏数据显式报错，不覆盖为默认值。 */
async function read(store: Store) {
  const saved = await store.read("defaults.json");
  const parsed = broadcastDefaultsRecordSchema.safeParse(saved ?? { revision: 0, value: initialBroadcastDefaults });
  if (!parsed.success) throw new AppError("STORAGE", "直播默认设置读取失败，请保留配置并联系管理员。", 500);
  return parsed.data;
}
/** 返回当前账号的默认值，不修改任何已有草稿或直播。 */
export async function GET(request: Request) {
  try { guard(request); const user = await authenticate(request); return Response.json(await read(storage(user)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failed(error); }
}
/** 显式保存仅影响未来新建草稿，原样重试可以安全确认。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request);
    const parsed = broadcastDefaultsRecordSchema.safeParse(await readJson(request, 2048));
    if (!parsed.success) throw new AppError("INPUT", "直播默认设置无效。", 400);
    const store = storage(user), incoming = parsed.data;
    const result = await transaction(store, async () => {
      const current = await read(store);
      if (current.revision !== incoming.revision) {
        if (current.revision === incoming.revision + 1 && JSON.stringify(current.value) === JSON.stringify(incoming.value)) return current;
        throw new AppError("CONFLICT", "默认设置已在其他窗口修改，请重新读取后保存。", 409);
      }
      const next = { revision: current.revision + 1, value: incoming.value };
      await store.write("defaults.json", next); return next;
    }, "defaults.lock");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failed(error); }
}
