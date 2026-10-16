/** 账号级 AI 密钥的加密保存与设备侧读取；账户名只来自已认证会话或设备归属。 */
import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { dataRoot } from "@/core/config";
import { Store, seal, unseal } from "@/core/storage";
import { transaction } from "@/cloud/store";
import { AppError } from "@/core/errors";
import { accountAiInputSchema, aiUsesSchema, type AccountAiStatus } from "@/shared/account-ai";
const recordSchema = z.object({ revision: z.number().int().positive(), uses: aiUsesSchema, secret: z.string().optional() }).strict();
/** 固定文件名和账号哈希隔离数据，不接收客户端指定路径。 */
function storage(username: string) { return new Store(path.join(dataRoot(), "account-ai", createHash("sha256").update(username).digest("hex"))); }
/** 损坏配置必须报错，不能伪装为未配置并覆盖。 */
async function record(username: string) { const value = await storage(username).read<unknown>("settings.json"); return value === null ? null : recordSchema.parse(value); }
/** 公开 DTO 只包含是否已保存与用途开关。 */
export async function accountAiStatus(username: string): Promise<AccountAiStatus> { const saved = await record(username); return { revision: saved?.revision || 0, configured: !!saved?.secret, managed: !!saved, uses: saved?.uses || { copy: true, chat: true } }; }
/** 同账号写入串行并校验修订号；留空保留已有密钥，不覆盖旧实例密钥文件。 */
export async function saveAccountAi(username: string, raw: unknown) {
  const parsed = accountAiInputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("INPUT", "请检查 API Key 和用途设置后重试。", 400);
  const value = parsed.data, store = storage(username);
  return transaction(store, async () => {
    const previous = await record(username);
    if (value.revision !== (previous?.revision || 0)) throw new AppError("CONFLICT", "AI 设置已更新，请重新读取后保存。", 409);
    if (!value.apiKey && !previous?.secret && (value.uses.copy || value.uses.chat)) throw new AppError("CONFIG", "请先填写账号 API Key，或关闭 AI 用途。", 400);
    await store.write("settings.json", { revision: (previous?.revision || 0) + 1, uses: value.uses, ...(value.apiKey ? { secret: seal({ apiKey: value.apiKey }) } : previous?.secret ? { secret: previous.secret } : {}) });
    return accountAiStatus(username);
  });
}
/** 仅供已认证的所属设备接口调用；返回值绝不能进入浏览器 DTO 或日志。 */
export async function accountAiEnvironment(username: string) { const saved = await record(username); return saved ? { managed: true, uses: saved.uses, ...(saved.secret ? unseal<{ apiKey: string }>(saved.secret) : {}) } : { managed: false }; }
