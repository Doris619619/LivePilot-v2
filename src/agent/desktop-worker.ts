/** 桌面专用 Node 子进程入口；初始化与维护 RPC 只通过父进程 IPC 传递。 */
import { z } from "zod";
import { runAgent } from "./runner";
import type { Transport } from "./transport";
import { safeError } from "@/core/errors";
const initSchema = z.object({ type: z.literal("init"), env: z.record(z.string(), z.string().optional()), identity: z.object({ agentId: z.string(), origin: z.string(), token: z.string() }) });
let started = false; let stopped = false; let transport: Transport | undefined;
/** 父进程通道失效时停止接收新任务，排空后退出。 */
process.on("disconnect", () => { stopped = true; });
/** 回传结构化状态，底层错误不含原始 HTTP/OBS 数据。 */
function send(value: unknown) { if (process.connected) process.send?.(value); }
/** 白名单处理宿主消息；未建立会话不能调用配置或维护接口。 */
process.on("message", async raw => {
  const message = raw as { type?: string; id?: string; route?: string; data?: unknown };
  if (message.type === "stop") { stopped = true; return; }
  if (message.type === "rpc") {
    try {
      if (!transport || !["maintenance-begin", "maintenance-end", "instances"].includes(message.route || "")) throw new Error("设备尚未连接或操作无效。");
      send({ type: "reply", id: message.id, result: await transport.post("/api/agent/" + message.route, message.data) });
    } catch (error) { send({ type: "reply", id: message.id, error: safeError(error) }); }
    return;
  }
  if (started) return;
  const parsed = initSchema.safeParse(raw); if (!parsed.success) return; started = true;
  Object.assign(process.env, parsed.data.env);
  try {
    await runAgent(parsed.data.identity, {
      stopped: () => stopped,
      snapshots: snapshots => send({ type: "snapshots", snapshots }),
      heartbeat: () => send({ type: "heartbeat", at: Date.now() }),
      error: (message, code) => { send({ type: "error", message, code }); },
      connected: async active => {
        // 与已有 Agent API 相同：Bearer、设备 ID、有效会话全部必需。
        const google = await active.post<{ clientId: string; clientSecret: string }>("/api/agent/bootstrap", {});
        process.env.GOOGLE_CLIENT_ID = google.clientId; process.env.GOOGLE_CLIENT_SECRET = google.clientSecret;
        transport = active; send({ type: "google", google });
      },
    }); process.exit(0);
  } catch (e) { send({ type: "error", message: safeError(e) }); process.exit(1); }
});
