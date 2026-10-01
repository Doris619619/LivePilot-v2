/** 普通视频独立 Prompt 和合法兜底；结果只生成一次并由 Runner 持久化。 */
import { requestAi, AiRequestError } from "../broadcast-ai";
import { Store } from "../storage";
import { AppError, sleep } from "../errors";
import { videoCopySchema } from "@/shared/video-metadata";
import type { JobSpec } from "@/shared/publishing";
/** 模板只支持明确变量，不执行表达式或用户代码。 */
export function expandTemplate(value: string, job: JobSpec) {
  const variables: Record<string, string> = { filenameStem: job.asset.filename.replace(/\.[^.]+$/, ""), index: String(job.index), channelId: job.profile.channelId, publishDate: job.originalPublishAt ? new Intl.DateTimeFormat("en-CA", { timeZone: job.profile.schedule.timezone, dateStyle: "medium" }).format(new Date(job.originalPublishAt)) : "" };
  return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => { if (!(key in variables)) throw new AppError("INPUT", "模板包含不支持的变量：" + key); return variables[key]; });
}
/** AI 仅接收获准的模板上下文，失败后直接使用用户已确认的兜底，不等待通知。 */
export async function publishingMetadata(storage: Store, job: JobSpec) {
  let copy = { title: expandTemplate(job.profile.titleTemplate, job), description: expandTemplate(job.profile.descriptionTemplate, job) };
  let source: "template" | "ai" | "fallback" | "override" = "template";
  if (job.profile.ai.enabled && (job.overrides.title === undefined || job.overrides.description === undefined)) {
    source = "fallback";
    copy = { title: expandTemplate(job.profile.ai.fallbackTitle, job), description: expandTemplate(job.profile.ai.fallbackDescription, job) };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = videoCopySchema.safeParse(await requestAi(storage, job.profile.ai.prompt + "\nReturn only JSON {title,description}. Title: at most 100 Unicode code points, description: at most 5000 UTF-8 bytes. Do not invent facts. Language: " + job.profile.ai.language, JSON.stringify({ filename: job.asset.filename, index: job.index, publishAt: job.originalPublishAt, template: copy })));
        if (!result.success) throw new AppError("AI_OUTPUT", "AI 文案不符合 YouTube 元数据要求。");
        copy = result.data; source = "ai"; break;
      } catch (e) { if ((e instanceof AiRequestError && !e.retryable) || (e instanceof AppError && e.code === "CONFIG")) break; if (attempt < 2) await sleep(1000 * (attempt + 1)); }
    }
  }
  if (job.overrides.title !== undefined || job.overrides.description !== undefined) { copy = { ...copy, ...job.overrides }; source = "override"; }
  const result = videoCopySchema.safeParse(copy);
  if (!result.success) throw new AppError("METADATA", "标题或说明超出 YouTube 限制，请修改模板或人工文案。没有静默截断。");
  return { copy: result.data, source };
}
