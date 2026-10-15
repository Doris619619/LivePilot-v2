/** 登录后共享的设置区域：集中选择设备及实例并管理 AI 服务，打开时保留当前工作区草稿。 */
"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import { targetKey, type AgentDescriptor } from "@/shared/remote";
import { api } from "../client-request";
import { SurfaceDialog } from "./ui/primitives";
import ApiKeySettings from "./api-key-settings";
import LiveChatSettings from "./live-chat-settings";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/primitives";
import "./api-settings.css";

type SettingsSection = "ai" | "chat";
const SettingsContext = createContext<((target?: InstanceDescriptor, section?: SettingsSection) => void) | undefined>(undefined);
type Inventory = { instances: InstanceDescriptor[]; agents?: AgentDescriptor[] };

/** 同一登录会话只挂载一个设置窗口，关闭时销毁密钥输入，不卸载业务页面。 */
export function ApiSettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<InstanceDescriptor>();
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<SettingsSection>("ai");
  /** 业务入口携带实例，公共入口允许用户主动选择，避免隐式写入首台设备。 */
  function show(instance?: InstanceDescriptor, tab: SettingsSection = "ai") { setTarget(instance); setSection(tab); setOpen(true); }
  return <SettingsContext.Provider value={show}>{children}<SurfaceDialog open={open} onOpenChange={setOpen} locked={saving} title="设置" description="管理服务凭据和长期偏好，关闭后继续当前操作。">{open && <SettingsContent initial={target} initialSection={section} onSaving={setSaving} saving={saving} />}</SurfaceDialog></SettingsContext.Provider>;
}

/** 侧栏账户区与生成区共享入口；目标由调用方显式提供。 */
export function ApiSettingsButton({ instance, section = "ai", children = "设置", className = "btn-ghost", disabled = false }: { instance?: InstanceDescriptor; section?: SettingsSection; children?: ReactNode; className?: string; disabled?: boolean }) {
  const show = useContext(SettingsContext);
  return <button type="button" className={className} disabled={disabled || !show} onClick={() => show?.(instance, section)}>{children}</button>;
}

/** 每次打开重新读取当前用户可见设备；目录读取失败时不回退到另一目标。 */
function SettingsContent({ initial, initialSection, onSaving, saving }: { initial?: InstanceDescriptor; initialSection: SettingsSection; onSaving: (value: boolean) => void; saving: boolean }) {
  const [section, setSection] = useState<string>(initialSection);
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
  const agent = inventory?.agents?.find(item => item.id === instance?.agentId);
  return <Tabs value={section} onValueChange={setSection} asChild><div className="api-settings">
    <TabsList aria-label="设置分类"><TabsTrigger value="ai" disabled={saving}>AI 服务与 API Key</TabsTrigger><TabsTrigger value="chat" disabled={saving}>互动偏好</TabsTrigger></TabsList>
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => { setError(""); setRevision(value => value + 1); }}>重新读取设备</button></div>}
    {!inventory && !error && <p role="status">正在读取设备…</p>}
    {inventory && <>
      <label htmlFor="api-settings-target">配置对象</label><select id="api-settings-target" value={selected} disabled={saving} onChange={event => setSelected(event.target.value)}><option value="">选择直播电脑 / OBS 实例</option>{inventory.instances.map(item => <option key={targetKey(item)} value={targetKey(item)}>{inventory.agents?.find(device => device.id === item.agentId)?.name || "本机电脑"} / {item.name}</option>)}</select>
      {!inventory.instances.length && <p role="status">还没有可配置的实例，请先接入直播电脑。</p>}
      {selected && !instance && <p role="status">此实例已不可用，请重新选择配置对象。</p>}
      {instance && <p className="api-settings-scope">当前对象：{agent?.name || "本机电脑"} / {instance.name}。其他实例保持各自配置。</p>}
    </>}
    <TabsContent value="ai">{instance && section === "ai" && <ApiKeySettings key={targetKey(instance)} instance={instance} offline={!!agent && !agent.online} onSaving={onSaving} />}</TabsContent>
    <TabsContent value="chat">{instance && section === "chat" && <LiveChatSettings key={targetKey(instance)} instance={instance} offline={!!agent && !agent.online} onSaving={onSaving} />}</TabsContent>
    <p className="api-settings-footnote">AI 观众互动使用管理员配置的独立服务；此处更换密钥不会修改互动服务。</p>
  </div></Tabs>;
}
