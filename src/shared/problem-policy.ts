/** 问题的业务影响与展示策略；不改变 problem-v1 的网络格式。 */
import type { Problem } from "./problems";
export type ProblemPresentation = "technical" | "status" | "action";
/** 只有已知的辅助检查可降为技术报告；未知原因保持可见。 */
export function problemPresentation(problem: Problem): ProblemPresentation {
  if (["FIREWALL_UNCONFIRMED", "FIREWALL_CHECK", "FIREWALL_SETUP"].includes(problem.code)) return "technical";
  if (["CANCELLED", "OBS_NOT_RUNNING", "DESKTOP_BUSY", "AGENT_DELETED", "UPDATE_STATE"].includes(problem.code)) return "status";
  return "action";
}
/** 与开播无关的更新和辅助检查不阻塞直播；结果未知的直播操作仍须核对。 */
export function blocksStart(problem: Problem) {
  if (problem.code === "CANCELLED" && problem.outcome === "unknown") return true;
  return problemPresentation(problem) === "action" && problem.domain !== "update" && problem.code !== "CHAT_ENVIRONMENT";
}
