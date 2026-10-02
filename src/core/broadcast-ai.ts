/** Agent 使用加密保存的 DeepSeek 密钥生成英文文案，不读写 YouTube 或启动 OBS。 */
import { aiBriefSchema, aiCopySchema, aiKeySchema } from "@/shared/broadcast-ai";
import { Store, seal, unseal } from "./storage";
import { AppError } from "./errors";
import { BROADCAST_COPY_PROMPT } from "./broadcast-copy-prompt";
export const DEEPSEEK_MODEL = "deepseek-flash";

/** 每实例独立保存密钥；响应仅确认保存，不回显密钥或声称已通过远端验证。 */
export async function saveAiKey(storage: Store, value: string) {
  const parsed = aiKeySchema.safeParse(value);
  if (!parsed.success) throw new AppError("INPUT", "请输入有效格式的 DeepSeek API Key。");
  await storage.write("deepseek.enc", seal({ apiKey: parsed.data }));
  return { configured: true };
}
/** 只返回配置存在性，解密失败不默默覆盖原密钥。 */
export async function aiStatus(storage: Store) {
  return { configured: !!await storage.read<string>("deepseek.enc") || !!process.env.DEEPSEEK_API_KEY?.trim() };
}
/** 固定官方地址、无自动重试；输出通过字段/长度校验后才进入网页草稿。 */
export async function generateCopy(storage: Store, input: string) {
  const parsed = aiBriefSchema.safeParse(input);
  if (!parsed.success) throw new AppError("INPUT", "请填写 1–500 字的音乐风格或主题。");
  const result = aiCopySchema.safeParse(await requestAi(storage, BROADCAST_COPY_PROMPT, parsed.data));
  if (!result.success) throw new AppError("AI_OUTPUT", "DeepSeek 未返回完整的英文标题和说明，请重新生成。原文案已保留。", 502);
  return result.data;
}
/** 共用官方 DeepSeek 请求，Prompt 和结果校验由直播/普通视频各自负责。 */
export async function requestAi(storage: Store, prompt: string, input: string) {
  const encrypted = await storage.read<string>("deepseek.enc");
  const value = encrypted ? unseal<{ apiKey: string }>(encrypted).apiKey : process.env.DEEPSEEK_API_KEY?.trim();
  if (!value) throw new AppError("CONFIG", "请先配置 DEEPSEEK_API_KEY 或在 DeepSeek 设置中保存 API Key。");
  const key = aiKeySchema.safeParse(value);
  if (!key.success) throw new AppError("CONFIG", "DeepSeek 密钥配置无效，请重新保存。");
  let response: Response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer " + key.data, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(40_000),
      body: JSON.stringify({ model: DEEPSEEK_MODEL, thinking: { type: "disabled" }, stream: false, max_tokens: 1600, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: input },
        ] }),
    });
  } catch { throw new AppError("AI_NETWORK", "DeepSeek 暂时无法连接或生成超时，请稍后重试。原文案已保留。", 502); }
  if (!response.ok) {
    await response.body?.cancel();
    const message = response.status === 401 ? "DeepSeek 未接受 API Key，请检查后重新保存。" : response.status === 402 ? "DeepSeek 余额不足，请充值后重试。" : response.status === 429 ? "DeepSeek 请求过于频繁，请稍后重试。" : "DeepSeek 服务暂时不可用，请稍后重试。";
    throw new AiRequestError(message, response.status === 429 || response.status >= 500);
  }
  const body = await response.json().catch(() => null) as { choices?: { finish_reason?: string; message?: { content?: string } }[] } | null;
  const choice = body?.choices?.[0];
  let content: unknown;
  try { content = JSON.parse(choice?.message?.content || ""); } catch { /* 原始响应不进入错误或日志。 */ }
  if (choice?.finish_reason !== "stop" || !content) throw new AppError("AI_OUTPUT", "DeepSeek 未返回完整的标题和说明，请重新生成。原文案已保留。", 502);
  return content;
}
export class AiRequestError extends AppError {
  /** 保留旧错误协议，额外区分永久配置/余额失败和可重试服务错误。 */
  constructor(message: string, readonly retryable: boolean) { super("AI_REQUEST", message, 502); }
}
