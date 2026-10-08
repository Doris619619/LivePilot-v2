/** 单机 Next 服务的聊天生命周期；进程持有所有实例，网页关闭不停止后台互动。 */
import "server-only";
import { instanceIds } from "@/core/config";
import { service, type Service } from "@/core/service";
const registry = globalThis as typeof globalThis & { livePilotLocalChat?: Service[] };
/** 启动只创建短初始化；后台循环自行运行，热重载不能重复创建监听器和聊天流。 */
export function startLocalChat() {
  if (registry.livePilotLocalChat) return;
  const apps = instanceIds().map(id => service(id));
  registry.livePilotLocalChat = apps;
  for (const app of apps) app.chat.start();
  /** 退出时取消未发送内容；sending 检查点保护强制退出后的不确定结果。 */
  const stop = () => { void Promise.all(apps.map(app => app.chat.stop())).catch(() => { /* 退出失败不输出本机状态或上游错误。 */ }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop); process.once("beforeExit", stop);
}
