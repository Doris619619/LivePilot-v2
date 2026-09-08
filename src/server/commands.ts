/** 每实例持久化命令受理与去重；浏览器断线不取消任务，进程重启不盲目重放。 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "./storage";
import { AppError, safeError } from "./errors";
import { audit } from "./audit";
import type { Control } from "./control";
import type { CommandStatus, Selection } from "@/shared/types";
export type CommandInput = { requestId: string; instanceId: string; action: "start" | "stop" | "launch" | "clear-uncertain"; video?: string; music?: string; videoAudio?: boolean; confirmed?: boolean };
type Record = CommandStatus & { fingerprint: string; owner: string; input: CommandInput };
const registry = globalThis as typeof globalThis & { livePilotCommandOwner?: string };
const owner = registry.livePilotCommandOwner ??= randomUUID();
/** 只存短命令，既有 Control 仍负责 OBS/YouTube 顺序和互斥。 */
export class Commands {
  private running = new Set<string>();
  /** 注入实例存储和控制器，所有命令严格归属当前实例。 */
  constructor(private storage: Store, private control: Control, private instanceId: string, private invalidate: () => void) {}
  /** 旧进程未确认的操作标为中断，真实 OBS/YouTube 由仪表盘继续读取。 */
  private async reconcile(record: Record | null) {
    if (record && record.owner !== owner && ["accepted", "running"].includes(record.status)) {
      record.status = "interrupted"; record.message = "服务曾重启，操作结果待核对。请检查实际直播状态后恢复；不会自动重放。"; record.updatedAt = new Date().toISOString();
      await this.storage.write(record.id + ".json", record);
    }
    return record;
  }
  /** 公开状态不包含内部命令参数和进程标识。 */
  private public(record: Record): CommandStatus {
    const { id, action, actor, status, updatedAt, message } = record;
    return { id, action, actor, status, updatedAt, message };
  }
  /** 读取最近命令，供重新打开页面的成员恢复实际执行进度。 */
  async latest() {
    const pointer = await this.storage.read<{ id: string }>("latest.json");
    const record = pointer && await this.reconcile(await this.storage.read<Record>(pointer.id + ".json"));
    return record ? this.public(record) : undefined;
  }
  /** OAuth 与其他写操作必须尊重已受理但尚未开始的命令。 */
  async assertIdle() {
    const latest = await this.latest();
    if (this.control.busy || (latest && ["accepted", "running"].includes(latest.status))) throw new AppError("BUSY", "该实例正在执行操作，请等待完成。", 409);
  }
  /** 短期授权操作与命令受理共享锁，避免受理到执行之间被重新授权。 */
  async withIdle<T>(fn: () => Promise<T>) {
    return this.storage.exclusive(async () => { await this.assertIdle(); return fn(); }, "commands.lock");
  }
  /** 同一请求标识及输入只受理一次；冲突请求不能覆盖执行中的命令。 */
  async accept(input: CommandInput, actor: string) {
    return this.storage.exclusive(async () => {
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const previous = await this.reconcile(await this.storage.read<Record>(input.requestId + ".json"));
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.actor !== actor) throw new AppError("REQUEST", "请求标识已用于其他操作。", 409);
        return { operation: this.public(previous), fresh: previous.status === "accepted" };
      }
      await this.assertIdle();
      const record: Record = { id: input.requestId, actor, action: input.action, status: "accepted", updatedAt: new Date().toISOString(), fingerprint, owner, input };
      await this.storage.write(record.id + ".json", record);
      await this.storage.write("latest.json", { id: record.id });
      return { operation: this.public(record), fresh: true };
    }, "commands.lock");
  }
  /** 由 after 在持久化受理后执行，不依赖请求的 abort signal。 */
  async run(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try { await this.execute(id); } finally { this.running.delete(id); }
  }
  /** 同进程同步认领后执行，响应丢失后的重复 after 不会并发重放。 */
  private async execute(id: string) {
    const record = await this.storage.read<Record>(id + ".json");
    if (!record || record.owner !== owner || record.status !== "accepted") return;
    record.status = "running"; record.updatedAt = new Date().toISOString();
    await this.storage.write(id + ".json", record);
    try {
      await audit(record.actor, record.action, this.instanceId, "running", id);
      const input = record.input;
      if (input.action === "start") await this.control.start({ video: input.video!, music: input.music!, videoAudio: input.videoAudio! } satisfies Selection);
      else if (input.action === "stop") await this.control.stop();
      else if (input.action === "launch") await this.control.launch();
      else await this.control.clearUncertain();
      record.status = "succeeded"; record.message = "操作已完成";
    } catch (error) { record.status = "failed"; record.message = safeError(error); }
    finally {
      record.updatedAt = new Date().toISOString();
      await this.storage.write(id + ".json", record);
      this.invalidate();
      await audit(record.actor, record.action, this.instanceId, record.status, id);
    }
  }
}
