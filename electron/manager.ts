/** 桌面业务协调；配置和更新串行化，页面只取得公开状态。 */
import { AppError } from "../src/core/errors";
import { app, dialog, net, session, shell } from "electron";
import path from "node:path";
import { mkdir, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { idSchema } from "../src/shared/remote";
import { DESKTOP_ORIGIN, type DesktopAction, type DesktopState } from "../src/shared/desktop";
import { SettingsStore, type Settings } from "./settings";
import { AgentHost } from "./agent-host";
import { copyDataLocation, preflightDataLocation, MIGRATION_FILE } from "./data-location";
import { hasData, ordinaryPath } from "./data-root";
import { Store } from "../src/core/storage";
import { configureCore, config } from "../src/core/config";
import { environment } from "./settings";
import { ObsProcessManager } from "../src/core/obs/process";
import { ObsDiscovery, inspectObs } from "./obs-discovery";
import { checkObsNetwork } from "./obs-network";
import { diagnose } from "./diagnostics";
import { assertLocalIdle, initializeObs, newInstance } from "./obs-setup";
import { Updates } from "./updates";
import { runLocalUpdate } from "./local-update";
import { isAppError, safeError, problemFor } from "../src/core/errors";
import { Activity } from "./activity";
import { separateCandidates, acceptCandidate, archiveCandidate } from "./candidates";
import { repairManagedObs } from "./obs-repair";
import { pairDesktop } from "./pairing";
export class Manager {
  settings!: Settings; readonly store = new SettingsStore(); readonly agent = new AgentHost(url => session.defaultSession.resolveProxy(url)); readonly updates = new Updates();
  readonly activity = new Activity(); readonly discovery = new ObsDiscovery();
  busy = false; message = ""; checks: DesktopState["checks"] = [];
  /** 用户数据与安装资源分离，更新不覆盖素材和 OBS 配置。 */
  constructor(readonly resources: string, private allowQuit: () => void, private customerHeaders: () => Record<string, string> = () => ({})) {}
  /** 启动只连接 Agent，不启动推流，失败留在可恢复界面。 */
  async init() {
    this.settings = await this.store.read(); separateCandidates(this.settings); await this.store.write(this.settings); this.busy = true;
    void (async () => { try { this.checks = await diagnose(this.settings, this.resources); if (this.settings.paired) { this.activity.begin("start"); await this.start(); this.activity.complete(); } } catch (e) { this.message = this.error(e); this.activity.fail(this.message); } finally { this.busy = false; } })();
  }
  /** 确认云端删除后排空 Agent，再原子保存未配对状态；保留 OBS、素材和密钥。 */
  async forgetBinding(agentId: string, confirm?: () => Promise<unknown>) {
    if (this.settings.identity?.agentId !== agentId) return;
    if (this.busy) throw new AppError("DESKTOP_BUSY", "设备已删除，正在等待当前操作结束后解除本机绑定。");
    this.busy = true;
    try {
      await confirm?.();
      await this.agent.stop();
      const next = { ...this.settings, paired: false, dataNotice: "设备绑定已删除。请在网页添加直播电脑，然后粘贴新配对码；本机 OBS 和素材已保留。" };
      delete next.identity; delete next.maintenance; delete next.inventoryPending;
      await this.store.write(next); this.settings = next;
      this.agent.snapshots = []; this.agent.problems = []; this.agent.lastHeartbeat = 0; this.agent.errorCode = undefined; this.agent.message = "";
      this.activity.value = undefined; this.message = "";
    } finally { this.busy = false; }
  }
  /** 逐字段复制公开实例，不向 Renderer 发送任何密码或令牌。 */
  state(): DesktopState {
    return { problems: this.agent.problems, dataLocationReady: !!this.settings.dataRoot, archivedCandidates: (this.settings.archivedCandidates || []).map(({id,name,managed,exe,port,initialized})=>({id,name,managed,exe,port,initialized})), scan: this.discovery.state, dataNotice: this.settings.dataNotice, activity: this.activity.value, version: app.getVersion(), dataRoot: this.settings.dataRoot, paired: !!this.settings.paired, agentId: this.settings.identity?.agentId, agentRunning: !!this.agent.child, online: Date.now() - this.agent.lastHeartbeat < 20_000, connectionError: this.agent.errorCode, autoStart: app.getLoginItemSettings().openAtLogin, busy: this.busy, message: this.message || this.agent.message, instances: this.settings.instances.map(i => ({ id: i.id, name: i.name, managed: i.managed, exe: i.exe, port: i.port, initialized: i.initialized })), candidates: (this.settings.candidates || []).map(({ id, name, managed, exe, port, initialized }) => ({ id, name, managed, exe, port, initialized })), maintenance: !!this.settings.maintenance, snapshots: this.agent.snapshots, checks: this.checks, update: this.updates.state };
  }
  /** 核心错误已过滤敏感字段，未知第三方异常使用固定提示。 */
  private error(e: unknown) { return isAppError(e) ? safeError(e) : e instanceof z.ZodError ? "输入无效，请检查填写内容。" : safeError(e); }
  /** 建立目录后启动；维护恢复只在新会话心跳确认之后释放。 */
  async start() {
    if (!this.settings.dataRoot) throw new AppError("DESKTOP", "请先选择 LiveNest 数据位置。");
    if (!this.settings.instances.length) throw new AppError("DESKTOP", "请先完成至少一个 OBS 的配置。");
    // 上次配置失败可能留下旧清单的活跃子进程；先在维护锁内同步，再重建会话。
    if (this.settings.maintenance && this.settings.inventoryPending && this.agent.child) {
      this.activity.progress("正在同步网页设备清单");
      await this.agent.rpc("instances", { token: this.settings.maintenance, instances: this.settings.instances.map(({ id, name }) => ({ id, name })) });
      await this.agent.stop(); this.activity.progress("正在等待旧连接结束（约 21 秒）"); await new Promise(r => setTimeout(r, 21_000));
    }
    for (const i of this.settings.instances) for (const kind of ["videos", "music"]) {const folder=path.join(this.settings.dataRoot,"media",i.id,kind);await ordinaryPath(folder);await mkdir(folder,{recursive:true});}
    this.activity.progress("正在连接网页并等待设备在线");
    await this.agent.start(this.settings, this.resources, async google => { this.settings.google = google; await this.store.write(this.settings); });
    await this.agent.ready();
    await this.releaseMaintenance();
  }
  /** 先保存随机维护凭据再发请求，响应丢失仍可幂等重试。 */
  async maintenance() {
    this.activity.progress("正在确认 OBS 空闲状态");
    await assertLocalIdle({ ...this.settings, instances: [...this.settings.instances, ...(this.settings.candidates || []), ...(this.settings.archivedCandidates || [])] });
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
    if (this.settings.inventoryPending) throw new AppError("MAINTENANCE", this.error(error) + " 设备清单仍待确认，请重新连接网页完成同步。");
    try { await assertLocalIdle(this.settings); await this.releaseMaintenance(); }
    catch { throw new AppError("MAINTENANCE", this.error(error) + " 维护恢复尚未确认，请点击重新连接网页；待配置 OBS 和原实例均已保留。"); }
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
    await pairDesktop(this.settings, invitation, () => this.store.write(this.settings), (url, init) => net.fetch(url, { ...init, headers: { ...init.headers, ...this.customerHeaders() } }));
    if (this.settings.dataNotice?.startsWith("设备绑定已删除")) { delete this.settings.dataNotice; await this.store.write(this.settings); }
    await this.start();
  }
  /** 全部写操作去重，失败保存配置并显示下一步提示。 */
  async act(action: DesktopAction, input: Record<string, unknown> = {}) {
    if (action === "web") { await shell.openExternal(DESKTOP_ORIGIN + "/workspace#" + (this.settings.identity ? (typeof input.id === "string" && this.settings.instances.some(i=>i.id===input.id) ? "instance-"+this.settings.identity.agentId+"-"+input.id : "device-" + this.settings.identity.agentId) : "workspace")); return this.state(); }
    if(action === "scan-cancel"){this.discovery.cancel();return this.state();}
    if(action === "scan"){this.discovery.start(input.deep===true,this.settings.instances.map(i=>i.exe));return this.state();}
    if(action === "firewall"){await shell.openExternal("ms-settings:windowsdefender");return this.state();}
    if (this.busy) throw new AppError("DESKTOP", "上一步仍在处理，请稍候。"); this.busy = true; this.message = ""; this.activity.begin(action, typeof input.id === "string" ? input.id : undefined);
    try {
      if (!this.settings.dataRoot && !["directory", "check", "autostart", "update-check", "update-download", "update-install", "update-apply"].includes(action)) throw new AppError("DESKTOP", "请先选择 LiveNest 数据位置。");
      if (action === "check") this.checks = await diagnose(this.settings, this.resources);
      else if (action === "diagnose-obs") { const item=[...this.settings.instances,...(this.settings.candidates||[])].find(i=>i.id===input.id);if(!item)throw new AppError("DESKTOP", "请选择 OBS。");configureCore(()=>environment({...this.settings,instances:[...this.settings.instances.filter(i=>i.id!==item.id),item]}));const result=await checkObsNetwork(item);this.checks=[...this.checks.filter(c=>c.id!==result.id),result]; }
      else if (action === "pair") { if (!this.settings.instances.length || this.settings.instances.some(i => !i.initialized)) throw new AppError("DESKTOP", "请先完成 OBS 配置。"); await this.pair(input.invitation); }
      else if (action === "start") await this.start();
      else if (action === "repair") await this.repair(input);
      else if (action === "discard") { archiveCandidate(this.settings, idSchema.parse(input.id)); await this.store.write(this.settings); if (this.settings.maintenance) await this.start(); }
      else if (action === "repair-managed") {
        const item = [...this.settings.instances, ...(this.settings.candidates || [])].find(i => i.id === input.id);
        if (!item?.managed) throw new AppError("DESKTOP", "只能修复本客户端管理的 OBS。");
        // 必须停止目标 OBS，才能绕过被其他程序占用的旧端口；其余实例仍完整检查。
        const candidate = await repairManagedObs(this.settings, item, async () => this.maintenanceForRepair(item.id));
        Object.assign(item, candidate); await this.store.write(this.settings);
        await this.configure("prepare", { id: item.id });
      }
      else if (["prepare", "add", "attach", "rename", "import-obs", "restore-candidate"].includes(action)) await this.configure(action, input);
      else if (action === "open-data") { if (await shell.openPath(this.settings.dataRoot)) throw new AppError("DESKTOP", "无法打开数据目录，请检查文件夹是否存在及访问权限。"); }
      else if (action === "directory") {
        const result = await dialog.showOpenDialog({ title:"选择 LiveNest 数据保存位置（自动创建 LiveNest 文件夹）", properties: ["openDirectory", "createDirectory"] });
        if(!result.canceled && result.filePaths[0]) await this.changeDirectory(path.join(result.filePaths[0], "LiveNest")); else this.activity.cancel();
      } else if (action === "autostart") app.setLoginItemSettings({ openAtLogin: z.boolean().parse(input.enabled), path: app.getPath("exe"), args: ["--hidden"] });
      else if (action === "update-check") await this.updates.check();
      else if (action === "update-download") await this.updates.download();
      else if (action === "update-install" || action === "update-apply") {
        if (action === "update-apply") await this.updates.download();
        const result = await runLocalUpdate({
          wasRunning: !!this.agent.child,
          checkIdle: () => assertLocalIdle({ ...this.settings, instances: [...this.settings.instances, ...(this.settings.candidates || []), ...(this.settings.archivedCandidates || [])] }),
          stop: () => this.agent.stop(), flush: () => this.store.flush(),
          reconnect: () => this.agent.start(this.settings, this.resources, async google => { this.settings.google = google; await this.store.write(this.settings); }),
          install: prepare => this.updates.install(prepare, this.allowQuit),
        });
        if (!result) this.activity.cancel();
      }
      else throw new AppError("DESKTOP", "操作不受支持。");
      if (["prepare","add","import-obs","repair-managed","repair","attach","directory","restore-candidate"].includes(action)) this.checks = await diagnose(this.settings, this.resources);
      this.activity.complete();
    } catch (e) { this.message = this.error(e); const problem = problemFor(e,{source:"desktop",target:{instanceId:this.activity.value?.instanceId},stage:isAppError(e) && e.problem ? e.problem.stage : this.activity.value?.stage,attemptId:this.activity.value?.attemptId}); this.activity.fail(this.message,problem); if(e instanceof z.ZodError)throw e; throw new AppError(problem.code,this.message,400,problem); } finally { this.busy = false; }
    return this.state();
  }
  /** 有数据走维护复制事务；新位置配置验证成功后才替换当前内存状态。 */
  private async changeDirectory(target: string) {
    if (this.settings.dataRoot && path.resolve(target).toLowerCase() === path.resolve(this.settings.dataRoot).toLowerCase()) return;
    if (!await hasData(this.settings)) {
      const next = await this.store.select(target); this.settings = next;
      if (next.paired) await this.start();
      return;
    }
    await preflightDataLocation(this.settings,target,app.isPackaged?path.dirname(app.getPath("exe")):undefined);
    const items = [...this.settings.instances, ...(this.settings.candidates || []), ...(this.settings.archivedCandidates || [])];
    const inspectSettings = { ...this.settings, instances: items };
    configureCore(() => environment(inspectSettings));
    /** 迁移包含失败和归档 OBS；运行中不能复制其会变化的配置。 */
    const closed = async () => { for(const item of items) { const exists=await access(item.exe).then(()=>true,error=>{if(error.code==="ENOENT"&&!item.initialized)return false;throw error;});if(!exists)continue; const status = await new ObsProcessManager(()=>config(item.id)).inspect(); if(status.pid || status.portPid) throw new AppError("DESKTOP", "迁移前请确认结束直播和录制，并关闭所有 OBS（包括待配置 OBS）；原位置保留。"); } };
    await closed();
    const answer = await dialog.showMessageBox({type:"question",message:"将数据复制到 " + target + "，校验成功后切换。原目录保留，设备与频道无需重新配对。",buttons:["取消","复制并切换"],defaultId:0,cancelId:0});
    if(answer.response!==1){this.activity.cancel();return;}
    await this.maintenance();
    const originalRoot=this.settings.dataRoot; let failure: unknown; let failed=false; let failureStage="复制数据";
    try {
      await this.agent.stop(); configureCore(()=>environment(inspectSettings)); await closed();
      const next = await copyDataLocation(this.settings,target,stage=>this.activity.progress(stage),app.isPackaged?path.dirname(app.getPath("exe")):undefined);
      await this.store.write(next); this.settings=next;
      const journal=new Store(target); const record=await journal.read<Record<string,unknown>>(MIGRATION_FILE);
      await journal.write(MIGRATION_FILE,{...record,stage:"switched"});
    } catch(e) { failure=e;failed=true;failureStage=this.activity.value?.stage || failureStage; } finally {
      if(this.settings.paired) {
        this.activity.progress("正在恢复网页连接");
        try { await new Promise(r=>setTimeout(r,21000)); await this.start(); }
        catch(e) { const message=(failed ? safeError(failure)+" 另：" : this.settings.dataRoot!==originalRoot ? "数据已切换到新位置，无需再次迁移。" : "原数据位置保留。")+"网页连接未恢复，请点击重新连接；"+safeError(e); const problem=problemFor(failed?failure:e,{domain:"storage",stage:failed?failureStage:"恢复网页连接",outcome:this.settings.dataRoot!==originalRoot?"partial":"unknown"});throw new AppError(problem.code,message,503,{...problem,message}); }
      }
    }
    if(failed) { const problem=problemFor(failure,{domain:"storage",stage:failureStage,outcome:this.settings.dataRoot!==originalRoot?"partial":"rejected"});throw new AppError(problem.code,problem.message,400,problem); }
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
    if (!item || item.managed) throw new AppError("DESKTOP", "只能修正尚未提交的手动 OBS 连接信息。");
    if ([...this.settings.instances, ...(this.settings.candidates || [])].some(i => i.id !== item.id && i.port === value.port)) throw new AppError("DESKTOP", "端口已被其他实例使用。");
    Object.assign(item, { port: value.port, password: value.password }); await this.store.write(this.settings);
    await this.configure("prepare", { id: item.id });
  }
  /** 仅在维护窗口改变实例；取消文件选择不留下维护锁。 */
  private async configure(action: string, input: Record<string, unknown>) {
    if (this.settings.inventoryPending) await this.start();
    let sourceExe:string|undefined;
    let instanceName:string|undefined;
    if(action === "import-obs" || action === "add") {
      instanceName=input.name===undefined ? undefined : z.string().trim().min(1).max(80).parse(input.name);
      if(action === "import-obs") {
        let selected=typeof input.exe === "string" ? input.exe : undefined;
        if(!selected){const result=await dialog.showOpenDialog({title:"选择已有 OBS（将复制为独立实例）",properties:["openFile"],filters:[{name:"OBS obs64.exe",extensions:["exe"]}]});if(result.canceled){this.activity.cancel();return;}selected=result.filePaths[0];}
        const candidate=await inspectObs(selected);if(candidate.running)throw new AppError("DESKTOP", "请先关闭来源 OBS 再复制。原程序和配置将保留。");sourceExe=candidate.exe;
      }
    }
    let external: { exe: string; port: number; password: string } | undefined;
    if (action === "attach") {
      const value = z.object({ port: z.number().int().min(1024).max(65535), password: z.string().min(1).max(256) }).parse(input);
      const selected = await dialog.showOpenDialog({ title: "选择专用便携 OBS", properties: ["openFile"], filters: [{ name: "OBS", extensions: ["exe"] }] }); if (selected.canceled) {this.activity.cancel();return;}
      const exe = selected.filePaths[0]; if (path.basename(exe).toLowerCase() !== "obs64.exe" || [...this.settings.instances,...(this.settings.candidates||[]),...(this.settings.archivedCandidates||[])].some(i => i.exe.toLowerCase() === exe.toLowerCase() || i.port === value.port)) throw new AppError("DESKTOP", "请选择独立的 obs64.exe 路径和端口。"); external = { exe, ...value };
    }
    // 创建 main 前必须显式恢复旧候选，不能因为“添加”隐式改变候选来源。
    if (["add","import-obs","attach"].includes(action) && !this.settings.instances.some(i=>i.id==="main") && [...(this.settings.candidates||[]),...(this.settings.archivedCandidates||[])].some(i=>i.id==="main")) throw new AppError("DESKTOP", "请先继续准备第一个 OBS，或恢复已撤销的首个候选。");
    await this.maintenance();
    try {
      if (action === "rename") {
        const value = z.object({ id: idSchema, name: z.string().trim().min(1).max(80) }).parse(input);
        const item = this.settings.instances.find(i => i.id === value.id); if (!item) throw new AppError("DESKTOP", "OBS 不存在。"); item.name = value.name;
      } else {
        const all = [...this.settings.instances, ...(this.settings.candidates || []), ...(this.settings.archivedCandidates || [])];
        let item: Settings["instances"][number] | undefined;
        if (action === "restore-candidate") {
          item = this.settings.archivedCandidates?.find(i=>i.id===input.id);
          if(!item)throw new AppError("DESKTOP", "归档候选不存在。");
          if(this.settings.instances.length+(this.settings.candidates?.length||0)>=64)throw new AppError("DESKTOP", "同机最多 64 个实例。");
          this.settings.archivedCandidates=this.settings.archivedCandidates?.filter(i=>i.id!==item!.id);
          (this.settings.candidates ||= []).push(item); await this.store.write(this.settings);
        } else if (action === "prepare") {
          item = input.id ? [...this.settings.instances,...(this.settings.candidates||[])].find(i=>i.id===input.id) : this.settings.candidates?.length===1 ? this.settings.candidates[0] : this.settings.instances.length===1 && !this.settings.candidates?.length ? this.settings.instances[0] : undefined;
          if(!item)throw new AppError("DESKTOP", "请选择要重试的 OBS；首次使用请点击“准备第一个 OBS”。");
        } else {
          if(!this.settings.instances.some(i=>i.id==="main") && all.some(i=>i.id==="main"))throw new AppError("DESKTOP", "请先继续准备第一个 OBS；已撤销的首个候选可点击“恢复配置”。");
          if(this.settings.instances.length+(this.settings.candidates?.length||0)>=64)throw new AppError("DESKTOP", "同机最多 64 个实例。");
          item=await newInstance({...this.settings,instances:all});
          if(external)Object.assign(item,{managed:false,...external});
          if(sourceExe)item.sourceExe=sourceExe;
          if(instanceName)item.name=instanceName;
          (this.settings.candidates ||= []).push(item); await this.store.write(this.settings);
        }
        if(this.activity.value)this.activity.value={...this.activity.value,instanceId:item.id};
        for(const kind of ["videos","music"]) { const folder=path.join(this.settings.dataRoot,"media",item.id,kind); await ordinaryPath(folder); await mkdir(folder,{recursive:true}); }
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
