/** 云端客户边界：所有浏览器目标请求与桌面设备访问共用归属校验。 */
import "server-only";
import type { Member } from "./access";
import { listAgents } from "@/cloud/agents";
import { AppError } from "@/core/errors";
/** 不暴露其他客户的设备是否存在，包括已撤销设备的恢复入口。 */
export async function authorizeAgent(user: Member, id: string) {
  const agent = (await listAgents()).find(a => a.id === id);
  if (!agent || (user.role !== "admin" && agent.owner !== user.username)) throw new AppError("FORBIDDEN", "无法访问这台电脑，请确认账号或联系管理员分配。", 403);
  return agent;
}
