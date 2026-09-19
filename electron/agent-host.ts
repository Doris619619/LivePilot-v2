/** 内置 Node Agent 子进程管理；白名单 IPC，优雅排空，不使用 Electron RunAsNode。 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentSnapshot } from "../src/shared/remote";
import { environment, type Settings } from "./settings";
export class AgentHost {
  child?: ChildProcess; snapshots: AgentSnapshot[] = []; lastHeartbeat = 0; message = "";
  private replies = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  /** 只恢复本客户端数据根下已确认死亡进程的宿主锁。 */
  async recover(settings: Settings) {
    const filename = path.join(settings.dataRoot, "state", "host.lock"); let pid: number;
    try { pid = Number(await readFile(filename, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("本机 Agent 锁损坏，请保留配置并查看帮助。");
    try { process.kill(pid, 0); throw new Error("已有进程使用本机 Agent 配置，请从原客户端退出后重试。"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    await unlink(filename);
  }
  /** 凭据走匿名 IPC，不出现在命令行、环境文件和 Renderer。 */
  async start(settings: Settings, resources: string, saveGoogle: (google: { clientId: string; clientSecret: string }) => Promise<void>) {
    if (this.child) return;
    if (!settings.paired || !settings.identity) throw new Error("请先完成设备配对。");
    await this.recover(settings); await mkdir(path.join(settings.dataRoot, "logs"), { recursive: true });
    this.lastHeartbeat = 0; this.message = "";
    const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(LIVEPILOT_|GOOGLE_|NODE_OPTIONS|ELECTRON_)/.test(key)) delete env[key];
    const child = spawn(path.join(resources, "vendor", "node.exe"), ["--use-env-proxy", path.join(resources, "agent", "desktop-worker.cjs")], { cwd: settings.dataRoot, env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    this.child = child;
    child.on("message", async raw => {
      const value = raw as { type: string; snapshots?: AgentSnapshot[]; at?: number; message?: string; google?: { clientId: string; clientSecret: string }; id?: string; error?: string; result?: unknown };
      if (value.type === "snapshots") this.snapshots = value.snapshots || [];
      if (value.type === "heartbeat") { this.lastHeartbeat = value.at || 0; this.message = ""; }
      if (value.type === "error") this.message = value.message || "Agent 连接失败。";
      if (value.type === "google" && value.google) try { await saveGoogle(value.google); } catch { this.message = "无法保存本机配置，请检查目录权限。"; }
      if (value.type === "reply" && value.id) { const reply = this.replies.get(value.id); if (reply) { clearTimeout(reply.timer); this.replies.delete(value.id); if (value.error) reply.reject(new Error(value.error)); else reply.resolve(value.result); } }
    });
    child.once("error", () => { this.message = "内置 Agent 启动失败，请检查安装文件或重新安装。"; });
    child.once("exit", () => { if (this.child === child) this.child = undefined; this.lastHeartbeat = 0; for (const r of this.replies.values()) { clearTimeout(r.timer); r.reject(new Error("Agent 已退出，请重新连接后核对状态。")); } this.replies.clear(); });
    child.send({ type: "init", env: environment(settings), identity: settings.identity });
  }
  /** 受限维护 RPC 由拥有有效会话的 Agent 转发。 */
  rpc<T>(route: "maintenance-begin" | "maintenance-end" | "instances", data: unknown): Promise<T> {
    if (!this.child?.connected) return Promise.reject(new Error("设备未连接，不能确认维护状态。"));
    const id = randomUUID(); return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(id); reject(new Error("维护响应超时，请重连后恢复；没有开始强制重启。")); }, 40_000);
      this.replies.set(id, { resolve: value => resolve(value as T), reject, timer }); this.child!.send({ type: "rpc", id, route, data });
    });
  }
  /** 等待首次心跳；配对成功不等于设备已经在线。 */
  async ready() {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) { if (Date.now() - this.lastHeartbeat < 20_000) return; if (!this.child) throw new Error(this.message || "Agent 未运行。"); await new Promise(r => setTimeout(r, 500)); }
    throw new Error(this.message || "等待云端连接超时，请检查网络后重试。");
  }
  /** 优雅停止最多等待一分钟，超时保留运行进程而不是强杀。 */
  async stop() {
    const child = this.child; if (!child) return;
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Agent 仍在处理任务，已取消重启。")), 65_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.send({ type: "stop" }); });
  }
}
