/** 普通退出只排空本地 Agent，不依赖云端维护、不停止 OBS；更新仍走独立维护流程。 */
type Target = { busy: boolean; agent: { stop(): Promise<void> } };
type Prompts = { confirm(): Promise<boolean>; notify(message: string): Promise<void>; finish(): void };
export class Shutdown {
  private pending?: Promise<void>;
  /** 注入本地排空和 UI，便于离线、重复点击及退出超时回归。 */
  constructor(private target: Target, private prompts: Prompts) {}
  /** 托盘和系统退出共用一个请求，避免重复弹窗或同时停止 Agent。 */
  request() {
    if (!this.pending) this.pending = this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** 确认之后再次检查配置并独占本地操作；只有实际排空成功才允许应用退出。 */
  private async run() {
    if (this.target.busy) { await this.prompts.notify("配置仍在进行，请完成后退出。"); return; }
    if (!await this.prompts.confirm()) return;
    if (this.target.busy) { await this.prompts.notify("配置已开始，请完成后重试退出。"); return; }
    this.target.busy = true;
    try { await this.target.agent.stop(); this.prompts.finish(); }
    catch {
      this.target.busy = false;
      await this.prompts.notify("Agent 尚未确认退出，可能仍在处理已接收的任务。请稍后重试退出；没有强行关闭 OBS，也没有删除配置。");
      return;
    }
  }
}
