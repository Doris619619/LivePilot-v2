/** 桌面业务协调；配置和更新串行化，页面只取得公开状态。 */
import { app, dialog, net, session, shell } from "electron";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { idSchema } from "../src/shared/remote";
import { DESKTOP_ORIGIN, type DesktopAction, type DesktopState } from "../src/shared/desktop";
import { SettingsStore, type Settings } from "./settings";
import { AgentHost } from "./agent-host";
import { diagnose } from "./diagnostics";
import { assertLocalIdle, initializeObs, newInstance } from "./obs-setup";
import { Updates } from "./updates";
import { isAppError, safeError } from "../src/core/errors";
import { Activity } from "./activity";
import { separateCandidates, acceptCandidate, archiveCandidate } from "./candidates";
import { repairManagedObs } from "./obs-repair";
import { pairDesktop } from "./pairing";
export class Manager {
  settings!: Settings; readonly store = new SettingsStore(); readonly agent = new AgentHost(url => session.defaultSession.resolveProxy(url)); readonly updates = new Updates();
  readonly activity = new Activity();
  busy = false; message = ""; checks: DesktopState["checks"] = [];
  /** 用户数据与安装资源分离，更新不覆盖素材和 OBS 配置。 */
  constructor(readonly resources: string, private allowQuit: () => void) {}
  /** 启动只连接 Agent，不启动推流，失败留在可恢复界面。 */
  async init() {
    this.settings = await this.store.read(); separateCandidates(this.settings); await this.store.write(this.settings); this.busy = true;
    void (async () => { try { this.checks = await diagnose(this.settings, this.resources); if (this.settings.paired) { this.activity.begin("start"); await this.start(); this.activity.complete(); } } catch (e) { this.message = this.error(e); this.activity.fail(this.message); } finally { this.busy = false; } })();
  }
  /** 逐字段复制公开实例，不向 Renderer 发送任何密码或令牌。 */
  state(): DesktopState {
    return { activity: this.activity.value, version: app.getVersion(), dataRoot: this.settings.dataRoot, paired: !!this.settings.paired, agentId: this.settings.identity?.agentId, agentRunning: !!this.agent.child, online: Date.now() - this.agent.lastHeartbeat < 20_000, connectionError: this.agent.errorCode, autoStart: app.getLoginItemSettings().openAtLogin, busy: this.busy, message: this.message || this.agent.message, instances: this.settings.instances.map(i => ({ id: i.id, name: i.name, managed: i.managed, exe: i.exe, port: i.port, initialized: i.initialized })), candidates: (this.settings.candidates || []).map(({ id, name, managed, exe, port, initialized }) => ({ id, name, managed, exe, port, initialized })), maintenance: !!this.settings.maintenance, snapshots: this.agent.snapshots, checks: this.checks, update: this.updates.state };
  }
  /** 核心错误已过滤敏感字段，未知第三方异常使用固定提示。 */
  private error(e: unknown) { return isAppError(e) ? safeError(e) : e instanceof z.ZodError ? "输入无效，请检查填写内容。" : e instanceof Error ? e.message : "操作未完成，请查看帮助并重试。"; }
  /** 建立目录后启动；维护恢复只在新会话心跳确认之后释放。 */
  async start() {
    if (!this.settings.instances.length) throw new Error("请先完成至少一个 OBS 的配置。");
    // 上次配置失败可能留下旧清单的活跃子进程；先在维护锁内同步，再重建会话。
    if (this.settings.maintenance && this.settings.inventoryPending && this.agent.child) {
      this.activity.progress("正在同步网页设备清单");
      await this.agent.rpc("instances", { token: this.settings.maintenance, instances: this.settings.instances.map(({ id, name }) => ({ id, name })) });
      await this.agent.stop(); this.activity.progress("正在等待旧连接结束（约 21 秒）"); await new Promise(r => setTimeout(r, 21_000));
    }
    for (const i of this.settings.instances) for (const kind of ["videos", "music"]) await mkdir(path.join(this.settings.dataRoot, "media", i.id, kind), { recursive: true });
    this.activity.progress("正在连接网页并等待设备在线");
    await this.agent.start(this.settings, this.resources, async google => { this.settings.google = google; await this.store.write(this.settings); });
    await this.agent.ready();
    await this.releaseMaintenance();
  }
  /** 先保存随机维护凭据再发请求，响应丢失仍可幂等重试。 */
  async maintenance() {
    this.activity.progress("正在确认 OBS 空闲状态");
    await assertLocalIdle(this.settings);
    if (!this.settings.paired) return;
    this.settings.maintenance ||= randomBytes(32).toString("hex"); await this.store.write(this.settings);
    await this.agent.rpc("maintenance-begin", { token: this.settings.maintenance });
  }
  /** 云端确认释放后才删除凭据；失败保留凭据以便重连恢复。 */
  private async releaseMaintenance() {
    if (!this.settings.maintenance) return;
    await assertLocalIdle(this.settings);
    await this.agent.rpc("maintenance-end", { token: this.settings.maintenance });
    const next = { ...this.settings }; delete next.maintenance; delete next.inventoryPending; await this.store.write(next); this.settings = next;
  }
  /** 验证失败未改变正式清单，安全放回旧实例，响应不明时明确保留维护。 */
  private async recoverConfiguration(error: unknown): Promise<never> {
    if (this.settings.inventoryPending) throw new Error(this.error(error) + " 设备清单仍待确认，请重新连接网页完成同步。");
    try { await assertLocalIdle(this.settings); await this.releaseMaintenance(); }
    catch { throw new Error(this.error(error) + " 维护恢复尚未确认，请点击重新连接网页；待配置 OBS 和原实例均已保留。"); }
    throw error;
  }
  /** 云端清单登记后优雅停止，等待旧会话防复制窗口，再启动新 Agent。 */
  private async commitInstances() {
    if (!this.settings.paired) return;
    this.settings.inventoryPending = true; await this.store.write(this.settings);
    this.activity.progress("正在同步网页设备清单");
    await this.agent.rpc("instances", { token: this.settings.maintenance, instances: this.settings.instances.map(({ id, name }) => ({ id, name })) });
    await this.store.write(this.settings); await this.agent.stop(); this.activity.progress("正在等待旧连接结束（约 21 秒）"); await new Promise(r => setTimeout(r, 21_000)); await this.start();
  }
  /** 新邀请可恢复原电脑；只有云端确认结果且本机保存成功后才等待 Agent 上线。 */
  private async pair(invitation: unknown) {
    await pairDesktop(this.settings, invitation, () => this.store.write(this.settings), (url, init) => net.fetch(url, init));
    await this.start();
  }
  /** 全部写操作去重，失败保存配置并显示下一步提示。 */
  async act(action: DesktopAction, input: Record<string, unknown> = {}) {
    if (action === "web") { await shell.openExternal(DESKTOP_ORIGIN + "/#" + (this.settings.identity ? "device-" + this.settings.identity.agentId : "workspace")); return this.state(); }
    if (this.busy) throw new Error("上一步仍在处理，请稍候。"); this.busy = true; this.message = ""; this.activity.begin(action);
    try {
      if (action === "check") this.checks = await diagnose(this.settings, this.resources);
      else if (action === "pair") { if (!this.settings.instances.length || this.settings.instances.some(i => !i.initialized)) throw new Error("请先完成 OBS 配置。"); await this.pair(input.invitation); }
      else if (action === "start") await this.start();
      else if (action === "repair") await this.repair(input);
      else if (action === "discard") { archiveCandidate(this.settings, idSchema.parse(input.id)); await this.store.write(this.settings); if (this.settings.maintenance) await this.start(); }
      else if (action === "repair-managed") {
        const item = [...this.settings.instances, ...(this.settings.candidates || [])].find(i => i.id === input.id);
        if (!item?.managed) throw new Error("只能修复本客户端管理的 OBS。");
        // 必须停止目标 OBS，才能绕过被其他程序占用的旧端口；其余实例仍完整检查。
        const candidate = await repairManagedObs(this.settings, item, async () => this.maintenanceForRepair(item.id));
        Object.assign(item, candidate); await this.store.write(this.settings);
        await this.configure("prepare", { id: item.id });
      }
      else if (["prepare", "add", "attach", "rename"].includes(action)) await this.configure(action, input);
      else if (action === "open-data") { if (await shell.openPath(this.settings.dataRoot)) throw new Error("无法打开数据目录，请检查文件夹是否存在及访问权限。"); }
      else if (action === "directory") {
        if (this.settings.instances.length || this.settings.candidates?.length || this.settings.archivedCandidates?.length || this.settings.identity) throw new Error("配置 OBS 后不能直接更换数据目录。");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); if (!result.canceled) { this.settings.dataRoot = path.join(result.filePaths[0], "LiveNest"); await this.store.write(this.settings); }
      } else if (action === "autostart") app.setLoginItemSettings({ openAtLogin: z.boolean().parse(input.enabled), path: app.getPath("exe"), args: ["--hidden"] });
      else if (action === "update-check") await this.updates.check();
      else if (action === "update-download") await this.updates.download();
      else if (action === "update-install") await this.updates.install(async () => { await this.maintenance(); await this.agent.stop(); }, this.allowQuit);
      else throw new Error("操作不受支持。");
      this.activity.complete();
    } catch (e) { this.message = this.error(e); this.activity.fail(this.message); throw new Error(this.message); } finally { this.busy = false; }
    return this.state();
  }
  /** 修复已停止的自有 OBS 时，只排除目标旧端口检查，云端维护仍必须确认。 */
  private async maintenanceForRepair(id: string) {
    await assertLocalIdle({ ...this.settings, instances: this.settings.instances.filter(i => i.id !== id) });
    if (!this.settings.paired) return;
    this.settings.maintenance ||= randomBytes(32).toString("hex"); await this.store.write(this.settings);
    await this.agent.rpc("maintenance-begin", { token: this.settings.maintenance });
  }
  /** 候选手动连接可修正；正式配对实例仍要求用户在 OBS 恢复原设置。 */
  private async repair(input: Record<string, unknown>) {
    const value = z.object({ id: idSchema, port: z.number().int().min(1024).max(65535), password: z.string().min(1).max(256) }).parse(input);
    const item = this.settings.candidates?.find(i => i.id === value.id);
    if (!item || item.managed) throw new Error("只能修正尚未提交的手动 OBS 连接信息。");
    if ([...this.settings.instances, ...(this.settings.candidates || [])].some(i => i.id !== item.id && i.port === value.port)) throw new Error("端口已被其他实例使用。");
    Object.assign(item, { port: value.port, password: value.password }); await this.store.write(this.settings);
    await this.configure("prepare", { id: item.id });
  }
  /** 仅在维护窗口改变实例；取消文件选择不留下维护锁。 */
  private async configure(action: string, input: Record<string, unknown>) {
    if (this.settings.inventoryPending) await this.start();
    let external: { exe: string; port: number; password: string } | undefined;
    if (action === "attach") {
      const value = z.object({ port: z.number().int().min(1024).max(65535), password: z.string().min(1).max(256) }).parse(input);
      const selected = await dialog.showOpenDialog({ title: "选择专用便携 OBS", properties: ["openFile"], filters: [{ name: "OBS", extensions: ["exe"] }] }); if (selected.canceled) return;
      const exe = selected.filePaths[0]; if (path.basename(exe).toLowerCase() !== "obs64.exe" || this.settings.instances.some(i => i.exe.toLowerCase() === exe.toLowerCase() || i.port === value.port)) throw new Error("请选择独立的 obs64.exe 路径和端口。"); external = { exe, ...value };
    }
    await this.maintenance();
    try {
      if (action === "rename") {
        const value = z.object({ id: idSchema, name: z.string().trim().min(1).max(80) }).parse(input);
        const item = this.settings.instances.find(i => i.id === value.id); if (!item) throw new Error("OBS 不存在。"); item.name = value.name;
      } else {
        const all = [...this.settings.instances, ...(this.settings.candidates || []), ...(this.settings.archivedCandidates || [])];
        let item = [...this.settings.instances, ...(this.settings.candidates || [])].find(i => i.id === input.id)
          || this.settings.candidates?.[0] || (action === "prepare" ? this.settings.instances[0] : undefined);
        if (input.id && ![...this.settings.instances, ...(this.settings.candidates || [])].some(i => i.id === input.id)) throw new Error("OBS 不存在。");
        if (external && this.settings.candidates?.length) throw new Error("请先修正或撤销现有待配置 OBS，再接入新的 OBS。");
        if (!item && !this.settings.instances.some(i => i.id === "main")) {
          item = this.settings.archivedCandidates?.find(i => i.id === "main");
          if (item && !external) {
            this.settings.archivedCandidates = this.settings.archivedCandidates?.filter(i => i !== item);
            (this.settings.candidates ||= []).push(item);
          }
        }
        if (external || !item) {
          if (this.settings.instances.length + (this.settings.candidates?.length || 0) >= 64) throw new Error("同机最多 64 个实例。");
          item = await newInstance({ ...this.settings, instances: all });
          if (external) Object.assign(item, { managed: false, ...external });
          (this.settings.candidates ||= []).push(item); await this.store.write(this.settings);
        }
        const candidateSettings = { ...this.settings, instances: [...this.settings.instances.filter(i => i.id !== item.id), item] };
        await initializeObs(candidateSettings, item, this.resources, stage => this.activity.progress(item!.name + " · " + stage));
        const next = { ...this.settings, instances: [...this.settings.instances], candidates: [...(this.settings.candidates || [])] };
        acceptCandidate(next, { ...item, initialized: true });
        await this.store.write(next); this.settings = next;
      }
      await this.store.write(this.settings);
    } catch (error) { return this.recoverConfiguration(error); }
    // 清单提交可能已经到达云端，失败后只能重试，不能撤销已验证实例。
    await this.commitInstances();
  }
}
