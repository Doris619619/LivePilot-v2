/** 内置 Agent 生命周期：启动确认、进程退出与 IPC 失败各自结算，禁止重复进程。 */
import { AppError } from "../src/core/errors";
import { spawn, type ChildProcess, type Serializable } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { problemSchema, makeProblem, type Problem } from "../src/shared/problems";
import type { AgentSnapshot } from "../src/shared/remote";
import { environment, type Settings } from "./settings";
import { agentEnvironment, type ProxyResolver } from "./agent-network";
export class AgentHost {
  problems: Problem[] = []; private saveProblem?: Problem;
  child?: ChildProcess; snapshots: AgentSnapshot[] = []; lastHeartbeat = 0; message = ""; errorCode?: string;
  private starting?: Promise<void>;
  /** 生产环境由 Electron 提供系统代理解析器，测试无需启动桌面会话。 */
  constructor(private readonly resolveProxy?: ProxyResolver) {}
  private replies = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  /** 只恢复本客户端数据根下已确认死亡进程的宿主锁。 */
  async recover(settings: Settings) {
    const filename = path.join(settings.dataRoot, "state", "host.lock"); let pid: number;
    try { pid = Number(await readFile(filename, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (!Number.isInteger(pid) || pid <= 0) throw new AppError("DESKTOP", "本机 Agent 锁损坏，请保留配置并查看帮助。");
    try { process.kill(pid, 0); throw new AppError("DESKTOP", "已有进程使用本机 Agent 配置，请从原客户端退出后重试。"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    await unlink(filename);
  }
  /** error 不代表进程必然死亡；仅无 PID、确认退出或 close 时释放引用。 */
  private finish(child: ChildProcess, message: string, closed = false) {
    if (this.child !== child) return;
    this.message = message; this.lastHeartbeat = 0; this.errorCode = undefined;
    for (const r of this.replies.values()) { clearTimeout(r.timer); r.reject(new AppError("AGENT_CONNECTION", message)); }
    this.replies.clear();
    if (closed || !child.pid || child.exitCode !== null || child.signalCode !== null) { this.child = undefined; this.snapshots = []; }
  }
  /** 并发启动复用同一个 Promise；存在存活或状态不明的进程时不再 spawn。 */
  async start(settings: Settings, resources: string, saveGoogle: (google: { clientId: string; clientSecret: string }) => Promise<void>) {
    if (this.starting) return this.starting;
    if (this.child) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) this.finish(this.child, "Agent 已退出。", true);
      else if (this.child.pid) {
        try { process.kill(this.child.pid, 0); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new AppError("DESKTOP", "无法确认 Agent 进程状态，未重复启动。"); this.finish(this.child, "Agent 已退出。", true); }
        if (this.child) { if (!this.child.connected) throw new AppError("DESKTOP", "Agent 进程仍存在但通信已断开，请等待其退出后重试。"); this.message = ""; this.errorCode = undefined; return; }
      } else this.finish(this.child, "Agent 未成功启动。", true);
    }
    this.starting = this.launch(settings, resources, saveGoogle);
    try { await this.starting; } finally { this.starting = undefined; }
  }
  /** spawn 成功后才发送凭据；发送失败不冒充启动成功。 */
  private async launch(settings: Settings, resources: string, saveGoogle: (google: { clientId: string; clientSecret: string }) => Promise<void>) {
    if (!settings.paired || !settings.identity) throw new AppError("DESKTOP", "请先完成设备配对。");
    await this.recover(settings); await mkdir(path.join(settings.dataRoot, "logs"), { recursive: true });
    this.lastHeartbeat = 0; this.message = ""; this.errorCode = undefined;
    const env = await agentEnvironment(process.env, settings.identity.origin, this.resolveProxy);
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try { child = spawn(path.join(resources, "vendor", "node.exe"), ["--use-env-proxy", path.join(resources, "agent", "desktop-worker.cjs")], { cwd: settings.dataRoot, env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }); }
      catch { this.message = "内置 Agent 启动失败，请检查安装文件后重试。"; reject(new AppError("AGENT_CONNECTION", this.message)); return; }
      this.child = child;
      child.on("message", async raw => {
        if (this.child !== child) return;
        const value = raw as { type: string; problems?: unknown[]; problem?: unknown; snapshots?: AgentSnapshot[]; at?: number; message?: string; code?: string; google?: { clientId: string; clientSecret: string }; id?: string; error?: string; result?: unknown };
        if (value.type === "problems") this.problems = [...(value.problems || []).flatMap(p=>{const parsed=problemSchema.safeParse(p);return parsed.success?[parsed.data]:[];}),...(this.saveProblem?[this.saveProblem]:[])];
        if (value.type === "snapshots") this.snapshots = value.snapshots || [];
        if (value.type === "heartbeat") { this.lastHeartbeat = value.at || 0; this.message = ""; this.errorCode = undefined; }
        if (value.type === "error") {
          this.lastHeartbeat = 0; this.errorCode = value.code;
          this.message = value.code === "AGENT_AUTH" ? "配对已失效。请在网页生成新配对码，粘贴后连接。原配置会保留。" : value.code === "CLOUD_NETWORK" ? "网络连接失败，正在自动重试。请检查网络或系统代理，无需重新配对。" : value.message || "连接失败，请重试。";
        }
        if (value.type === "google" && value.google) try { await saveGoogle(value.google); this.saveProblem=undefined; this.problems=this.problems.filter(p=>p.stage!=="保存频道应用配置"); } catch { this.saveProblem=makeProblem("RESULT_SAVE","无法保存本机配置，请检查原数据盘和目录权限，再重新连接。",{stage:"保存频道应用配置"}); this.problems=[...this.problems.filter(p=>p.stage!=="保存频道应用配置"),this.saveProblem]; }
        if (value.type === "reply" && value.id) { const reply = this.replies.get(value.id); if (reply) { clearTimeout(reply.timer); this.replies.delete(value.id); if (value.error) { const parsed=problemSchema.safeParse(value.problem);reply.reject(new AppError(parsed.success?parsed.data.code:"AGENT_REQUEST",value.error,400,parsed.success?parsed.data:undefined)); } else reply.resolve(value.result); } }
      });
      child.on("error", () => { const message = "内置 Agent 启动或通信失败，请检查安装文件后重试。"; this.finish(child, message); reject(new AppError("AGENT_CONNECTION", message)); });
      child.once("exit", () => { this.finish(child, "Agent 已退出，请重新连接后核对状态。", true); reject(new AppError("AGENT_CONNECTION", "Agent 在启动期间退出。")); });
      child.once("close", () => { this.finish(child, "Agent 已关闭，请重新连接后核对状态。", true); reject(new AppError("AGENT_CONNECTION", "Agent 在启动期间关闭。")); });
      child.once("disconnect", () => this.finish(child, "Agent 通信已断开，正在等待进程退出。"));
      child.once("spawn", () => { void this.send(child, { type: "init", env: environment(settings), identity: settings.identity }).then(resolve, reject); });
    });
  }
  /** IPC 发送回调与同步异常均结算调用者；通道错误不强杀仍运行的 Agent。 */
  private send(child: ChildProcess, value: Serializable): Promise<void> {
    return new Promise((resolve, reject) => {
      const failed = () => { const message = "Agent 通信失败，请重新连接后核对状态。"; this.finish(child, message); reject(new AppError("AGENT_CONNECTION", message)); };
      if (!child.connected) { failed(); return; }
      try { child.send(value, error => { if (error) failed(); else resolve(); }); } catch { failed(); }
    });
  }
  /** 维护 RPC 发送失败立即清理等待项，迟到的旧进程消息不影响新会话。 */
  rpc<T>(route: "maintenance-begin" | "maintenance-end" | "instances", data: unknown): Promise<T> {
    const child = this.child;
    if (this.errorCode === "AGENT_AUTH") return Promise.reject(new AppError("AGENT_AUTH", this.message || "设备配对已失效，请在原电脑恢复配对后重试。"));
    if (!child?.connected) return Promise.reject(new AppError("AGENT_CONNECTION", "设备未连接，不能确认维护状态。"));
    const id = randomUUID(); return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(id); reject(new AppError("AGENT_CONNECTION", "维护响应超时，请重连后恢复；没有开始强制重启。")); }, 40_000);
      this.replies.set(id, { resolve: value => resolve(value as T), reject, timer });
      void this.send(child, { type: "rpc", id, route, data }).catch(error => { clearTimeout(timer); this.replies.delete(id); reject(error); });
    });
  }
  /** 等待首次心跳；已有明确错误立即交还重试入口，后台 Agent 保持自动重连。 */
  async ready() {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) { if (Date.now() - this.lastHeartbeat < 20_000) return; if (this.message) throw new AppError(this.errorCode || "AGENT_CONNECTION", this.message); if (!this.child?.connected) throw new AppError("AGENT_CONNECTION", "Agent 未运行，请重新连接。"); await new Promise(r => setTimeout(r, 500)); }
    throw new AppError("AGENT_CONNECTION", this.message || "等待云端连接超时，请检查网络后重试。");
  }
  /** 优雅停止等待 exit/close；超时保留存活进程，失败移除等待监听器。 */
  async stop() {
    if (this.starting) await this.starting;
    const child = this.child; if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) { this.finish(child, "Agent 已退出。", true); return; }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off("exit", done); child.off("close", done); };
      const done = () => { cleanup(); resolve(); };
      const timer = setTimeout(() => { cleanup(); reject(new AppError("AGENT_CONNECTION", "Agent 仍在处理任务，已取消重启。")); }, 65_000);
      child.once("exit", done); child.once("close", done);
      void this.send(child, { type: "stop" }).catch(error => { cleanup(); reject(error); });
    });
  }
}
