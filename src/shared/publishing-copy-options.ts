/** 本次视频发布的 AI 文案选择；不从可复用发布配置包继承。 */
import { profileSchema, type PublishingProfile } from "./publishing";

export const publishingCopyOptionsSchema = profileSchema.shape.ai.pick({ enabled: true, language: true, prompt: true });
export type PublishingCopyOptions = Pick<PublishingProfile["ai"], "enabled" | "language" | "prompt">;

/** 新发布默认不生成文案；调用方可独立编辑语言与要求。 */
export function defaultPublishingCopyOptions(): PublishingCopyOptions {
  return { enabled: false, language: "English", prompt: "根据素材主题生成准确、自然的视频标题和说明。" };
}

/** 关闭生成时空输入不阻塞发布；开启时交给表单和服务端校验。 */
export function effectivePublishingCopyOptions(options: PublishingCopyOptions): PublishingCopyOptions {
  const defaults = defaultPublishingCopyOptions();
  return options.enabled ? options : { ...options, language: options.language || defaults.language, prompt: options.prompt || defaults.prompt };
}

/** 只为本次执行构建文案规则，旧固定文案不参与新计划。 */
export function publishingCopyForUse(options: PublishingCopyOptions = defaultPublishingCopyOptions()): PublishingProfile["ai"] {
  return { ...publishingCopyOptionsSchema.parse(effectivePublishingCopyOptions(options)), fallbackTitle: "{{packageName}}", fallbackDescription: "" };
}
