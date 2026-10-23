/** 配额表单的数值边界、中文字段错误与草稿转换；提交仍由共享政策 schema 校验。 */
import { youtubePolicySchema, type YouTubePolicy } from "@/shared/youtube-usage";

export const policyFields: { key: keyof YouTubePolicy; label: string; min: number; max: number }[] = [
  { key: "providerDailyUnits", label: "Google 通用每日配额", min: 1000, max: 1_000_000 },
  { key: "dailyUnits", label: "通用每日预算", min: 100, max: 900_000 },
  { key: "controlReserve", label: "开停播预留", min: 0, max: 10000 },
  { key: "sendUnits", label: "聊天发送上限", min: 0, max: 1_000_000 },
  { key: "streamUnits", label: "聊天室连接上限", min: 0, max: 1_000_000 },
  { key: "backgroundUnits", label: "后台状态上限", min: 0, max: 1_000_000 },
  { key: "unitsPerMinute", label: "每分钟 units", min: 1, max: 10000 },
  { key: "burstUnits", label: "瞬时 units 上限", min: 50, max: 10000 },
  { key: "searchesPerDay", label: "每日搜索次数", min: 0, max: 10000 },
  { key: "uploadsPerDay", label: "每日上传次数", min: 0, max: 10000 },
];
export type PolicyInput = Record<keyof YouTubePolicy, string>;
export type PolicyErrors = Partial<Record<keyof YouTubePolicy, string>>;
const number = new Intl.NumberFormat("zh-CN");

/** 数字转为可清空的受控草稿；清空输入不能悄悄变成零预算。 */
export function policyInputValues(policy: YouTubePolicy): PolicyInput {
  return Object.fromEntries(policyFields.map(field => [field.key, String(policy[field.key])])) as PolicyInput;
}

/** 返回可以关联到控件的中文错误，预算之间的约束分别定位总预算或控制预留。 */
export function validatePolicyInput(input: PolicyInput): { policy?: YouTubePolicy; errors: PolicyErrors } {
  const errors: PolicyErrors = {};
  const values = Object.fromEntries(policyFields.map(field => [field.key, Number(input[field.key])])) as YouTubePolicy;
  for (const field of policyFields) {
    const value = values[field.key];
    if (!input[field.key].trim() || !Number.isInteger(value) || value < field.min || value > field.max) errors[field.key] = `${field.label}请输入 ${number.format(field.min)}–${number.format(field.max)} 之间的整数。`;
  }
  if (Object.keys(errors).length) return { errors };
  if (values.dailyUnits > Math.floor(values.providerDailyUnits * .9)) errors.dailyUnits = "通用每日预算不能超过 Google 通用每日配额的 90%。";
  if (values.controlReserve >= values.dailyUnits) errors.controlReserve = "开停播预留必须小于通用每日预算。";
  if (Object.keys(errors).length) return { errors };
  const parsed = youtubePolicySchema.safeParse(values);
  return parsed.success ? { policy: parsed.data, errors } : { errors: { dailyUnits: "请检查总预算与各项配额的范围后重试。" } };
}
