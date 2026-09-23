/** 管理员分组、指标筛选和时区显示；保留零实例电脑与未接入客户。 */
import type { overview } from "@/cloud/overview";
export type Overview = Awaited<ReturnType<typeof overview>>;
export type Scope = "all" | "live" | "online" | "offline" | "customers" | "error" | "unknown" | "idle";
export type Group = { customer: string; devices: { agent: Overview["agents"][number]; rows: Overview["rows"] }[] };
export const scopes: Record<Scope, string> = { all: "全部状态", live: "正在推流", online: "在线电脑", offline: "离线电脑", customers: "全部客户", error: "异常实例", unknown: "状态未知", idle: "未推流" };
/** 与指标口径一致，离线错误不混入在线异常数量。 */
function matches(row: Overview["rows"][number], scope: Scope) {
  if (scope === "live") return row.online && row.streaming === true;
  if (scope === "error") return row.online && !!row.error;
  if (scope === "unknown") return row.streaming === null;
  if (scope === "idle") return row.streaming === false;
  return true;
}
/** 先筛选客户和电脑再列出 OBS；电脑指标不能遗漏零实例设备。 */
export function groupOverview(data: Overview, scope: Scope, customer = "", device = ""): Group[] {
  const active = data.agents.filter(a => !a.revoked && !a.pairedTo);
  const names = [...new Set([...data.customers.map(c => c.username), ...active.map(a => a.owner || "")])];
  const rowScope = ["live", "error", "unknown", "idle"].includes(scope);
  return names.filter(name => (!customer || name === (customer === "unassigned" ? "" : customer)) && (scope !== "customers" || data.customers.some(c => c.username === name))).map(name => {
    const devices = active.filter(a => (a.owner || "") === name && (!device || a.id === device) && (scope !== "online" || a.online) && (scope !== "offline" || !a.online)).map(agent => ({ agent, rows: data.rows.filter(r => r.agentId === agent.id && matches(r, scope)) })).filter(d => !rowScope || d.rows.length > 0);
    return { customer: name, devices };
  }).filter(g => g.devices.length > 0 || (!device && ["all", "customers"].includes(scope) && data.customers.some(c => c.username === g.customer)));
}
/** 损坏的浏览器偏好不会使日期格式化失败。 */
export function validTimeZone(value: string) { try { new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(0); return true; } catch { return false; } }
/** 更新时间统一中文日期和 24 小时制，按所选 IANA 时区转换。 */
export function updateTime(at: number, timeZone: string) { return at ? new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(at) : "未上线"; }
