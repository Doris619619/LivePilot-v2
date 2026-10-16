/** 登录后共享设置中心：稳定分类布局与内存草稿；关闭时确认丢弃，不卸载工作区。 */
"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import { targetKey, type AgentDescriptor } from "@/shared/remote";
import { api } from "../client-request";
import { SurfaceDialog } from "./ui/primitives";
import ApiKeySettings from "./api-key-settings";
import BroadcastDefaultSettings from "./broadcast-default-settings";
import BroadcastProfileSettings from "./broadcast-profile-settings";
import { Tabs, TabsList, TabsTrigger } from "./ui/primitives";
import { SettingsPanel } from "./settings-panel";
import "./api-settings.css";
import { SettingsDraftContext } from "./settings-drafts";

type SettingsSection = "ai" | "chat" | "defaults" | "profiles";
const SettingsContext = createContext<((target?: InstanceDescriptor, section?: SettingsSection) => void) | undefined>(undefined);
type Inventory = { instances: InstanceDescriptor[]; agents?: AgentDescriptor[] };

/** 同一登录会话只挂载一个设置窗口，关闭时销毁密钥输入，不卸载业务页面。 */
export function ApiSettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<InstanceDescriptor>();
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<SettingsSection>("ai");
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [confirmClose, setConfirmClose] = useState(false);
  const continueButton = useRef<HTMLButtonElement>(null);
  /** 汇总各页编辑标记，分类切换不会销毁表单或把密钥写入持久存储。 */
  const reportDirty = useCallback((id: string, value: boolean) => setDirty(current => current[id] === value ? current : { ...current, [id]: value }), []);
  useEffect(() => { if (confirmClose) continueButton.current?.focus(); }, [confirmClose]);
  /** 所有关闭入口共用丢弃保护；保存请求仍由对话框锁定。 */
  function changeOpen(value: boolean) {
    if (!value && Object.values(dirty).some(Boolean)) { setConfirmClose(true); return; }
    setConfirmClose(false); setOpen(value);
  }
  /** 业务入口携带实例，公共入口允许用户主动选择，避免隐式写入首台设备。 */
  function show(instance?: InstanceDescriptor, tab: SettingsSection = "ai") { setTarget(instance); setSection(tab); setConfirmClose(false); setOpen(true); }
  return <SettingsContext.Provider value={show}>{children}<SurfaceDialog open={open} onOpenChange={changeOpen} locked={saving} title="设置" description="管理账号 AI 服务、默认参数与直播配置包。" descriptionHidden>{open && <SettingsDraftContext.Provider value={reportDirty}><SettingsContent initial={target} initialSection={section} onSaving={setSaving} saving={saving} />{confirmClose && <div className="settings-close-confirm" role="alert"><p>有未保存的修改，确定关闭？</p><div><button ref={continueButton} type="button" className="btn-secondary" onClick={() => setConfirmClose(false)}>继续编辑</button><button type="button" onClick={() => { setConfirmClose(false); setOpen(false); }}>放弃修改并关闭</button></div></div>}</SettingsDraftContext.Provider>}</SurfaceDialog></SettingsContext.Provider>;
}

/** 侧栏账户区与生成区共享入口；目标由调用方显式提供。 */
export function ApiSettingsButton({ instance, section = "ai", children = "设置", className = "btn-ghost", disabled = false }: { instance?: InstanceDescriptor; section?: SettingsSection; children?: ReactNode; className?: string; disabled?: boolean }) {
  const show = useContext(SettingsContext);
  return <button type="button" className={className} disabled={disabled || !show} onClick={() => show?.(instance, section)}>{children}</button>;
}

/** 每次打开重新读取当前用户可见设备；目录读取失败时不回退到另一目标。 */
function SettingsContent({ initial, initialSection, onSaving, saving }: { initial?: InstanceDescriptor; initialSection: SettingsSection; onSaving: (value: boolean) => void; saving: boolean }) {
  const [section, setSection] = useState<string>(initialSection === "chat" ? "ai" : initialSection);
  const [mobileDetail, setMobileDetail] = useState(true);
  const settingsRoot = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  /** 手机分类与详情切换后把焦点送入可见区域，避免停留在隐藏的导航按钮。 */
  function focusMobile(detail: boolean) {
    requestAnimationFrame(() => {
      if (!window.matchMedia("(max-width: 600px)").matches) return;
      if (detail) detailHeading.current?.focus();
      else settingsRoot.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  }
  const [inventory, setInventory] = useState<Inventory>();
  const [selected, setSelected] = useState(initial ? targetKey(initial) : "");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    api<Inventory>("/api/instances", { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      const customer = new URLSearchParams(window.location.search).get("customer");
      const agents = result.agents?.filter(agent => !agent.revoked && agent.paired !== false && (!customer || agent.owner === customer));
      setInventory({ agents, instances: result.instances.filter(instance => !agents || agents.some(agent => agent.id === instance.agentId)) });
    }).catch(() => { if (!abort.signal.aborted) setError("无法读取设备列表，请重试。"); });
    return () => abort.abort();
  }, [revision]);
  const instance = inventory?.instances.find(item => targetKey(item) === selected);
  return <Tabs orientation="vertical" value={section} onValueChange={value => { setSection(value); setMobileDetail(true); focusMobile(true); }} asChild><div ref={settingsRoot} className="api-settings" data-mobile-detail={mobileDetail}>
    <TabsList aria-label="设置分类"><TabsTrigger value="ai" disabled={saving} onClick={() => { setMobileDetail(true); focusMobile(true); }}>AI 服务</TabsTrigger><TabsTrigger value="defaults" disabled={saving} onClick={() => { setMobileDetail(true); focusMobile(true); }}>默认参数</TabsTrigger><TabsTrigger value="profiles" disabled={saving} onClick={() => { setMobileDetail(true); focusMobile(true); }}>直播配置包</TabsTrigger></TabsList>
    <div className="settings-detail">
    <div className="settings-page-heading"><button type="button" className="btn-ghost settings-back" disabled={saving} onClick={() => { setMobileDetail(false); focusMobile(false); }}>返回分类</button><h3 ref={detailHeading} tabIndex={-1}>{section === "ai" ? "AI 服务" : section === "defaults" ? "默认参数" : "直播配置包"}</h3></div>
    <SettingsPanel value="defaults"><BroadcastDefaultSettings onSaving={onSaving} /></SettingsPanel>
    <SettingsPanel value="profiles">
    {section === "profiles" && error && <div role="alert"><p>{error}</p><button type="button" onClick={() => { setError(""); setRevision(value => value + 1); }}>重新读取设备</button></div>}
    {section === "profiles" && !inventory && !error && <p role="status">正在读取设备…</p>}
    {inventory && section === "profiles" && <>
      <div className="api-settings-target"><div className="api-settings-label"><label htmlFor="api-settings-target">配置对象</label><span>仅作用于所选实例</span></div><select id="api-settings-target" value={selected} disabled={saving || !inventory.instances.length} onChange={event => setSelected(event.target.value)}><option value="">选择直播电脑 / OBS 实例</option>{inventory.instances.map(item => <option key={targetKey(item)} value={targetKey(item)}>{inventory.agents?.find(device => device.id === item.agentId)?.name || "本机电脑"} / {item.name}</option>)}</select></div>
      {!inventory.instances.length && <p role="status">还没有可配置的实例，请先接入直播电脑。</p>}
      {selected && !instance && <p role="status">此实例已不可用，请重新选择配置对象。</p>}
    </>}
    {instance && <BroadcastProfileSettings key={targetKey(instance)} instance={instance} onSaving={onSaving} />}</SettingsPanel>
    <SettingsPanel value="ai"><ApiKeySettings onSaving={onSaving} /></SettingsPanel>
    </div>
  </div></Tabs>;
}
