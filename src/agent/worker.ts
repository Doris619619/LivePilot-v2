/** Agent 本机执行日志：接收先落盘，异步执行与云端连接完全解耦。 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Store, seal, unseal } from "@/core/storage";
import { isAppError, safeError, problemFor } from "@/core/errors";
import { taskSchema, type RemoteTask, type TaskReport } from "@/shared/remote";
import { makeProblem, type Problem } from "../shared/problems";
type Entry = { task: RemoteTask; report: TaskReport; owner: string; acknowledged?: boolean };
export class Worker {
  readonly problems = new Map<string, Problem>();
  private owner = randomUUID();
  private accepting: Promise<unknown> = Promise.resolve();
  private running = new Map<string, Promise<void>>();
  /** 注入执行器便于验证网络断开时任务仍可独立完成。 */
  constructor(readonly store: Store, private execute: (task: RemoteTask) => Promise<unknown>, private agentId?: string) {}
  /** 加密内部日志，OAuth code/cookie 不以明文持久化。 */
  private async write(entry: Entry) { await this.store.write(entry.task.id + ".json", seal(entry)); this.problems.delete(entry.task.id); }
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
    void promise.catch(() => { this.problems.set(task.id, makeProblem("RESULT_SAVE", "此操作结果未能保存，请检查本机磁盘并核对实际状态。", {source:"agent",target:{instanceId:task.instanceId},attemptId:task.id,stage:"保存操作结果"})); });
  }
  /** 后台执行不继承 HTTP abort signal；异常只保存过滤后的安全说明。 */
  private async run(entry: Entry) {
    try {
      entry.report.status = "running"; await this.write(entry);
      const result = await this.execute(entry.task); entry.report = { id: entry.task.id, status: "succeeded", result };
    } catch (error) { entry.report = { id: entry.task.id, status: "failed", error: safeError(error), httpStatus: isAppError(error) ? error.status : 500, problem: problemFor(error, {source:"agent",target:{instanceId:entry.task.instanceId},attemptId:entry.task.id}) }; }
    await this.write(entry);
  }
  /** 汇报所有未确认结果；重启的旧执行记录显示中断，不再启动执行器。 */
  async reports() {
    const reports: TaskReport[] = [];
    const files = await readdir(this.store.dir).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    for (const name of files.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const entry = await this.read(name.slice(0, -5)); if (!entry || entry.acknowledged || (this.agentId && entry.task.agentId !== this.agentId)) continue;
      if (entry.owner !== this.owner && ["accepted", "running"].includes(entry.report.status)) { entry.report = { id: entry.task.id, status: "interrupted", error: "Agent 曾重启，请核对 OBS 和 YouTube 后恢复。", httpStatus: 409 }; await this.write(entry); }
      reports.push(entry.report); if (reports.length >= 32) break;
    }
    return reports;
  }
  /** 云端确认终态后停止重复上报，仍保留本机去重记录。 */
  async acknowledge(ids: string[]) { for (const id of ids) { const entry = await this.read(id); if (entry && !["accepted", "running"].includes(entry.report.status)) { entry.acknowledged = true; await this.write(entry); } } }
  /** 先等待正在落盘的接收事务，再排空执行；不因控制端断线取消任务或丢弃结果。 */
  async drain() { await this.accepting; await Promise.all(this.running.values()); }
  /** 删除指定授权上下文的日志前仅等待相关执行；独立账号清理不会等待或删除同宿主直播任务。 */
  async purgeYouTube(instanceId: string, accountId?: string) {
    await this.accepting; const related: string[] = [];
    for (const name of await readdir(this.store.dir).catch(e => { if (e.code === "ENOENT") return []; throw e; })) if (/^[a-f0-9-]{36}\.json$/.test(name)) { const id = name.slice(0, -5); const entry = await this.read(id); const payload = entry?.task.payload; const kind = payload?.kind; const publishingAccount = payload?.kind === "publishing-apply" ? payload.job.profile.accountId : payload && "accountId" in payload ? payload.accountId : undefined; if (entry?.task.instanceId === instanceId && publishingAccount === accountId && kind && (kind.startsWith("publishing-") || kind.startsWith("oauth-") || ["broadcast-read", "broadcast-playlists", "control"].includes(kind))) related.push(id); }
    await Promise.all(related.map(id => this.running.get(id)));
    for (const id of related) await this.store.remove(id + ".json");
  }
}
