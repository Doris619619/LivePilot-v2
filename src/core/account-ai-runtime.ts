/** 设备进程内的账号 AI 策略；凭据只来自认证的 Cloud 同步，不写浏览器或实例文件。 */
import type { AiUses } from "@/shared/account-ai";
let current: { apiKey?: string; uses: AiUses } | undefined;
/** undefined 恢复旧部署兼容模式；显式受管但无密钥时禁止回退旧 Key。 */
export function setAccountAiRuntime(value: typeof current) { current = value; }
/** 调用者只在执行/配置检查时读取；不可序列化进状态 DTO。 */
export function accountAiRuntime() { return current; }
