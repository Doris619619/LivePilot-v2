/** 退役对账网络边界；响应头和完整响应体共用期限，超时不推断云端是否已提交。 */
import { net } from "electron";
import { AppError } from "../src/core/errors";
import type { Settings } from "./settings";

export const RETIREMENT_INVENTORY_TIMEOUT_MS = 20_000;
/** 只返回库存数据，不修改事务；即使底层忽略abort，晚到响应也不能继续恢复配置。 */
export async function readRetirementInventory(identity: NonNullable<Settings["identity"]>): Promise<unknown> {
  const cancellation = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  /** 截止后保持原身份、维护凭据和退役意图，用户可再次核对或正常退出。 */
  const timeout = () => new AppError("MAINTENANCE", "云端库存核对已超时，退役结果仍待核对；原身份、维护凭据和文件已保留，请重新连接并恢复。", 504);
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { cancellation.abort(); reject(timeout()); }, RETIREMENT_INVENTORY_TIMEOUT_MS); });
  /** 读取完整body也在同一期限内，成功与否都不把响应中的未知字段用于修改本地状态。 */
  async function read() {
    const response = await net.fetch(identity.origin + "/api/agent/instance-inventory", { method: "POST", headers: { "Content-Type": "application/json", "x-livepilot-agent": identity.agentId, Authorization: "Bearer " + identity.token }, body: "{}", signal: cancellation.signal });
    if (cancellation.signal.aborted) throw timeout();
    if (!response.ok) throw new AppError("MAINTENANCE", response.status === 404 ? "Cloud 尚不支持库存恢复，请升级 Cloud 后重新连接；退役记录与维护凭据已保留。" : "暂时无法确认云端库存，请恢复网络后重新连接；退役记录已保留。");
    return response.json();
  }
  try { return await Promise.race([read(), expired]); }
  catch (error) { if (cancellation.signal.aborted) throw timeout(); throw error; }
  finally { if (timer !== undefined) clearTimeout(timer); cancellation.abort(); }
}
