/** Agent 本机执行日志：接收先落盘，异步执行与云端连接完全解耦。 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Store, seal, unseal } from "@/core/storage";
import { isAppError, safeError } from "@/core/errors";
import { taskSchema, type RemoteTask, type TaskReport } from "@/shared/remote";
type Entry = { task: RemoteTask; report: TaskReport; owner: string; acknowledged?: boolean };
export class Worker {
  private owner = randomUUID();
  private accepting: Promise<unknown> = Promise.resolve();
  private running = new Map<string, Promise<void>>();
  /** 注入执行器便于验证网络断开时任务仍可独立完成。 */
  constructor(readonly store: Store, private execute: (task: RemoteTask) => Promise<unknown>) {}
  /** 加密内部日志，OAuth code/cookie 不以明文持久化。 */
  private async write(entry: Entry) { await this.store.write(entry.task.id + ".json", seal(entry)); }
  /** 只解密属于本机的协议记录。 */
  private async read(id: string) { const value = await this.store.read<string>(id + ".json"); return value ? unseal<Entry>(value) : null; }
  /** 首次接收持久化后即可离线执行；迟到或前进程残留不会重新执行。 */
  receive(value: RemoteTask) {
    const next = this.accepting.then(() => this.receiveOnce(value)); this.accepting = next.catch(() => {}); return next;
  }
  /** 只串行化短接收事务，长直播任务仍可跨实例并行执行。 */
  private async receiveOnce(value: RemoteTask) {
    const task = taskSchema.parse(value); const previous = await this.read(task.id);
    if (previous) {
      if (JSON.stringify(previous.task) !== JSON.stringify(task)) throw new Error("Task identity mismatch");
      if (previous.owner !== this.owner && ["accepted", "running"].includes(previous.report.status)) { previous.report = { id: task.id, status: "interrupted", error: "Agent 曾重启，任务结果待核对；没有自动重放。", httpStatus: 409 }; previous.acknowledged = false; await this.write(previous); }
      return;
    }
    const entry: Entry = { task, owner: this.owner, report: { id: task.id, status: task.expiresAt < Date.now() ? "expired" : "accepted" } };
    await this.write(entry);
    if (entry.report.status === "expired") return;
    const promise = this.run(entry).finally(() => this.running.delete(task.id)); this.running.set(task.id, promise);
    void promise.catch(() => { console.error("Agent 无法持久化任务结果；请保留数据并检查磁盘，云端将保持结果待核对。"); });
  }
  /** 后台执行不继承 HTTP abort signal；异常只保存过滤后的安全说明。 */
  private async run(entry: Entry) {
    try {
      entry.report.status = "running"; await this.write(entry);
      const result = await this.execute(entry.task); entry.report = { id: entry.task.id, status: "succeeded", result };
    } catch (error) { entry.report = { id: entry.task.id, status: "failed", error: safeError(error), httpStatus: isAppError(error) ? error.status : 500 }; }
    await this.write(entry);
  }
  /** 汇报所有未确认结果；重启的旧执行记录显示中断，不再启动执行器。 */
  async reports() {
    const reports: TaskReport[] = [];
    const files = await readdir(this.store.dir).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    for (const name of files.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const entry = await this.read(name.slice(0, -5)); if (!entry || entry.acknowledged) continue;
      if (entry.owner !== this.owner && ["accepted", "running"].includes(entry.report.status)) { entry.report = { id: entry.task.id, status: "interrupted", error: "Agent 曾重启，请核对 OBS 和 YouTube 后恢复。", httpStatus: 409 }; await this.write(entry); }
      reports.push(entry.report); if (reports.length >= 32) break;
    }
    return reports;
  }
  /** 云端确认终态后停止重复上报，仍保留本机去重记录。 */
  async acknowledge(ids: string[]) { for (const id of ids) { const entry = await this.read(id); if (entry && !["accepted", "running"].includes(entry.report.status)) { entry.acknowledged = true; await this.write(entry); } } }
  /** 测试和优雅退出使用；不因控制端断线取消任务。 */
  async drain() { await Promise.all(this.running.values()); }
}
