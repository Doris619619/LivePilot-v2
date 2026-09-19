/** 桌面业务协调；配置和更新串行化，页面只取得公开状态。 */
import { app, dialog, net, shell } from "electron";
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
const invitationSchema = z.object({ origin: z.literal(DESKTOP_ORIGIN), agentId: idSchema, code: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export class Manager {
  settings!: Settings; readonly store = new SettingsStore(); readonly agent = new AgentHost(); readonly updates = new Updates();
  readonly activity = new Activity();
  busy = false; message = ""; checks: DesktopState["checks"] = [];
  /** 用户数据与安装资源分离，更新不覆盖素材和 OBS 配置。 */
  constructor(readonly resources: string, private allowQuit: () => void) {}
  /** 启动只连接 Agent，不启动推流，失败留在可恢复界面。 */
  async init() {
    this.settings = await this.store.read(); await this.store.write(this.settings); this.busy = true;
    void (async () => { try { this.checks = await diagnose(this.settings, this.resources); if (this.settings.paired) await this.start(); } catch (e) { this.message = this.error(e); } finally { this.busy = false; } })();
  }
  /** 逐字段复制公开实例，不向 Renderer 发送任何密码或令牌。 */
  state(): DesktopState {
    return { activity: this.activity.value, version: app.getVersion(), dataRoot: this.settings.dataRoot, paired: !!this.settings.paired, agentId: this.settings.identity?.agentId, agentRunning: !!this.agent.child, online: Date.now() - this.agent.lastHeartbeat < 20_000, autoStart: app.getLoginItemSettings().openAtLogin, busy: this.busy, message: this.message || this.agent.message, instances: this.settings.instances.map(i => ({ id: i.id, name: i.name, managed: i.managed, exe: i.exe, port: i.port, initialized: i.initialized })), snapshots: this.agent.snapshots, checks: this.checks, update: this.updates.state };
  }
  /** 核心错误已过滤敏感字段，未知第三方异常使用固定提示。 */
  private error(e: unknown) { return isAppError(e) ? safeError(e) : e instanceof z.ZodError ? "输入无效，请检查填写内容。" : e instanceof Error ? e.message : "操作未完成，请查看帮助并重试。"; }
  /** 建立目录后启动；维护恢复只在新会话心跳确认之后释放。 */
  async start() {
    if (this.settings.instances.some(i => !i.initialized)) throw new Error("请先在本机 OBS 中完成尚未成功的配置，再重新连接网页。");
    // 上次配置失败可能留下旧清单的活跃子进程；先在维护锁内同步，再重建会话。
    if (this.settings.maintenance && this.agent.child) {
      this.activity.progress("正在同步网页设备清单");
      await this.agent.rpc("instances", { token: this.settings.maintenance, instances: this.settings.instances.map(({ id, name }) => ({ id, name })) });
      await this.agent.stop(); this.activity.progress("正在等待旧连接结束（约 21 秒）"); await new Promise(r => setTimeout(r, 21_000));
    }
    for (const i of this.settings.instances) for (const kind of ["videos", "music"]) await mkdir(path.join(this.settings.dataRoot, "media", i.id, kind), { recursive: true });
    this.activity.progress("正在连接网页并等待设备在线");
    await this.agent.start(this.settings, this.resources, async google => { this.settings.google = google; await this.store.write(this.settings); });
    await this.agent.ready();
    if (this.settings.maintenance) { await this.agent.rpc("maintenance-end", { token: this.settings.maintenance }); delete this.settings.maintenance; await this.store.write(this.settings); }
  }
  /** 先保存随机维护凭据再发请求，响应丢失仍可幂等重试。 */
  async maintenance() {
    this.activity.progress("正在确认 OBS 空闲状态");
    await assertLocalIdle(this.settings);
    if (!this.settings.paired) return;
    this.settings.maintenance ||= randomBytes(32).toString("hex"); await this.store.write(this.settings);
    await this.agent.rpc("maintenance-begin", { token: this.settings.maintenance });
  }
  /** 云端清单登记后优雅停止，等待旧会话防复制窗口，再启动新 Agent。 */
  private async commitInstances() {
    if (!this.settings.paired) return;
    this.activity.progress("正在同步网页设备清单");
    await this.agent.rpc("instances", { token: this.settings.maintenance, instances: this.settings.instances.map(({ id, name }) => ({ id, name })) });
    await this.store.write(this.settings); await this.agent.stop(); this.activity.progress("正在等待旧连接结束（约 21 秒）"); await new Promise(r => setTimeout(r, 21_000)); await this.start();
  }
  /** 邀请必须来自固定正式网站，重试复用已保存的随机设备令牌。 */
  private async pair(invitation: unknown) {
    if (this.settings.paired) throw new Error("这台电脑已经配对，不能覆盖设备身份。");
    if (typeof invitation !== "string" || invitation.length > 4096 || !invitation.trim().startsWith("LN1.")) throw new Error("请粘贴网页生成的完整配对信息。");
    let value: z.infer<typeof invitationSchema>;
    try { value = invitationSchema.parse(JSON.parse(Buffer.from(invitation.trim().slice(4), "base64url").toString("utf8"))); } catch { throw new Error("配对信息无效，或不属于 LiveNest 正式网站。"); }
    if (this.settings.identity && this.settings.identity.agentId !== value.agentId) throw new Error("有尚未完成的配对，请在网页重新生成原设备的邀请。");
    this.settings.identity ||= { agentId: value.agentId, origin: value.origin, token: randomBytes(32).toString("hex") }; await this.store.write(this.settings);
    let response: Response;
    try { response = await net.fetch(value.origin + "/api/agent/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocol: 1, agentId: value.agentId, code: value.code, token: this.settings.identity.token }), redirect: "error", signal: AbortSignal.timeout(20_000) }); } catch { throw new Error("无法连接网页服务，请检查网络后重试。配对身份已保留。"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error("配对未成功，请确认网页已升级，或重新生成原设备的配对信息。"); }
    await response.body?.cancel(); this.settings.paired = true; await this.store.write(this.settings); await this.start();
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
      else if (["prepare", "add", "attach", "rename"].includes(action)) await this.configure(action, input);
      else if (action === "directory") {
        if (this.settings.instances.length || this.settings.identity) throw new Error("配置 OBS 后不能直接更换数据目录。");
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
  /** 初次手动接入输错连接信息时，验证候选配置后再保存，不创建重复实例。 */
  private async repair(input: Record<string, unknown>) {
    if (this.settings.paired) throw new Error("已配对设备请先在 OBS 中恢复原有连接设置，避免中断远程任务。");
    const value = z.object({ id: idSchema, port: z.number().int().min(1024).max(65535), password: z.string().min(1).max(256) }).parse(input);
    const item = this.settings.instances.find(i => i.id === value.id);
    if (!item || item.managed) throw new Error("只能修正手动接入的 OBS 连接信息。");
    if (this.settings.instances.some(i => i.id !== item.id && i.port === value.port)) throw new Error("端口已被其他实例使用。");
    const candidate = { ...item, port: value.port, password: value.password }; const settings = { ...this.settings, instances: this.settings.instances.map(i => i.id === item.id ? candidate : i) };
    await assertLocalIdle(settings); await initializeObs(settings, candidate, this.resources, stage => this.activity.progress(stage));
    Object.assign(item, candidate, { initialized: true }); await this.store.write(this.settings);
  }
  /** 仅在维护窗口改变实例；取消文件选择不留下维护锁。 */
  private async configure(action: string, input: Record<string, unknown>) {
    let external: { exe: string; port: number; password: string } | undefined;
    if (action === "attach") {
      const value = z.object({ port: z.number().int().min(1024).max(65535), password: z.string().min(1).max(256) }).parse(input);
      const selected = await dialog.showOpenDialog({ title: "选择专用便携 OBS", properties: ["openFile"], filters: [{ name: "OBS", extensions: ["exe"] }] }); if (selected.canceled) return;
      const exe = selected.filePaths[0]; if (path.basename(exe).toLowerCase() !== "obs64.exe" || this.settings.instances.some(i => i.exe.toLowerCase() === exe.toLowerCase() || i.port === value.port)) throw new Error("请选择独立的 obs64.exe 路径和端口。"); external = { exe, ...value };
    }
    await this.maintenance();
    if (action === "rename") { const value = z.object({ id: idSchema, name: z.string().trim().min(1).max(80) }).parse(input); const item = this.settings.instances.find(i => i.id === value.id); if (!item) throw new Error("OBS 不存在。"); item.name = value.name; }
    else {
      let item = this.settings.instances.find(i => i.id === input.id) || this.settings.instances.find(i => !i.initialized) || (action === "prepare" ? this.settings.instances[0] : undefined);
      if (input.id && !this.settings.instances.some(i => i.id === input.id)) throw new Error("OBS 不存在。");
      if (external) { item = { ...await newInstance(this.settings), managed: false, ...external }; this.settings.instances.push(item); }
      else if (!item) { if (this.settings.instances.length >= 64) throw new Error("同机最多 64 个实例。"); item = await newInstance(this.settings); this.settings.instances.push(item); }
      await this.store.write(this.settings);
      const selected = input.id || action === "add" || action === "attach" ? [item] : this.settings.instances;
      for (const instance of selected) { await initializeObs(this.settings, instance, this.resources, stage => this.activity.progress(instance.name + " · " + stage)); instance.initialized = true; await this.store.write(this.settings); }
    }
    await this.store.write(this.settings); await this.commitInstances();
  }
}
