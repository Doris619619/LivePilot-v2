/** Agent 专用出站预览通道，与持久任务/心跳分离，媒体字节仅通过 HTTPS 二进制响应发送。 */
import { AppError, sleep } from "@/core/errors";
import { previewCommandSchema, type PreviewEnvelope } from "@/shared/media-preview";
import type { AgentPreviewSessions } from "@/core/preview/session";
import type { Transport } from "./transport";
export class MediaPreviewConnection {
  private enabled = false; private stopped = false; private loop?: Promise<void>;
  /** 仅双方声明能力后启动，旧 Cloud 不会收到新路由请求。 */
  constructor(private transport: Transport, private sessions: AgentPreviewSessions) {}
  /** 最多四个短请求并行；全片检查独立在 Runner 管理，轮询不等待解码结束。 */
  connect(enabled: boolean) {
    this.enabled = enabled; if (this.stopped || this.loop || !enabled) return;
    this.loop = (async () => { while (!this.stopped) {
      this.sessions.sweep();
      if (this.enabled) try {
        const response = await this.transport.request("/api/agent/media-preview/poll", {}, 25_000);
        const { requests } = await response.json() as { requests: unknown[] };
        if (this.stopped) break;
        await Promise.all(requests.map(async value => {
          if (this.stopped) return;
          const command = previewCommandSchema.parse(value); if (command.target.agentId !== this.transport.agentId) return;
          let body: Uint8Array | PreviewEnvelope;
          try { const result = await this.sessions.execute(command); body = result instanceof Uint8Array ? result : { data: result }; }
          catch (error) { body = { error: error instanceof AppError ? error.message : "设备无法读取预览素材，请检查文件后重试。", code: error instanceof AppError ? error.code : "PREVIEW_FAILED", status: error instanceof AppError ? error.status : 500 }; }
          const binary = body instanceof Uint8Array;
          const accepted = await this.transport.request("/api/agent/media-preview/" + command.id, { method: "POST", headers: { "content-type": binary ? "application/octet-stream" : "application/json" }, body: binary ? new Uint8Array(body as Uint8Array) : JSON.stringify(body) });
          await accepted.body?.cancel();
        }));
      } catch { /* 专用预览错误只交给发起者，不打印字节、路径或凭据。 */ }
      if (!this.stopped) await sleep(this.enabled ? 150 : 1000);
    } })();
  }
  /** 退出先取消检查，再等待当前有界网络请求结束。 */
  async stop() { this.stopped = true; await this.sessions.stop(); await this.loop; }
}
