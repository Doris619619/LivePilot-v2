/** 只记录已选择的操作者及业务标识，禁止序列化请求、令牌或上游错误。 */
import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { accessStore } from "./access";
import { Store } from "./storage";
/** 每条审计使用独立原子文件，多实例写入互不覆盖。 */
export async function audit(actor: string, action: string, instanceId: string, result: string, reference = "") {
  const store = new Store(path.join(accessStore().dir, "audit"));
  await store.write(Date.now() + "-" + randomUUID() + ".json", { actor, action, instanceId, result, reference, at: new Date().toISOString() });
}
