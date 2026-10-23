/** 登录后共享设置中心：稳定分类布局与内存草稿；关闭时确认丢弃，不卸载工作区。 */
"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import { SurfaceDialog } from "./ui/primitives";
import ApiKeySettings from "./api-key-settings";
import BroadcastDefaultSettings from "./broadcast-default-settings";
import PublishingProfileSettings from "./publishing-profile-settings";
import type { PublishingTarget } from "../publishing/profile-editor";
import BroadcastProfileSettings from "./broadcast-profile-settings";
import { Tabs, TabsList, TabsTrigger } from "./ui/primitives";
import { SettingsPanel } from "./settings-panel";
import "./api-settings.css";
import { SettingsDraftContext } from "./settings-drafts";
import { useUnsavedChanges } from "../use-unsaved-changes";

type SettingsSection = "ai" | "chat" | "defaults" | "profiles" | "video-profiles";
const SettingsContext = createContext<((target?: InstanceDescriptor, section?: SettingsSection, publishingTarget?: PublishingTarget) => void) | undefined>(undefined);


/** 同一登录会话只挂载一个设置窗口，关闭时销毁密钥输入，不卸载业务页面。 */
export function ApiSettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<SettingsSection>("ai");
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  useUnsavedChanges(open && Object.values(dirty).some(Boolean));
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
  /** 兼容已有业务入口参数；账号设置不再依赖设备目标。 */
  function show(_instance?: InstanceDescriptor, tab: SettingsSection = "ai") { setSection(tab); setConfirmClose(false); setOpen(true); }
  return <SettingsContext.Provider value={show}>{children}<SurfaceDialog open={open} onOpenChange={changeOpen} locked={saving} title="设置" description="管理账号 AI 服务、默认参数与发布配置。" descriptionHidden>{open && <SettingsDraftContext.Provider value={reportDirty}><SettingsContent initialSection={section} onSectionChange={setSection} onSaving={setSaving} saving={saving} />{confirmClose && <div className="settings-close-confirm" role="alert"><p>有未保存的修改，确定关闭？</p><div><button ref={continueButton} type="button" className="btn-secondary" onClick={() => setConfirmClose(false)}>继续编辑</button><button type="button" onClick={() => { setConfirmClose(false); setOpen(false); }}>放弃修改并关闭</button></div></div>}</SettingsDraftContext.Provider>}</SurfaceDialog></SettingsContext.Provider>;
}

/** 业务页打开统一设置，保留其自身向导和上传；目标仅用于初始选择。 */
export function useOpenSettings() { return useContext(SettingsContext); }

/** 侧栏账户区与生成区共享入口；目标由调用方显式提供。 */
export function ApiSettingsButton({ instance, section = "ai", children = "设置", className = "btn-ghost", disabled = false }: { instance?: InstanceDescriptor; section?: SettingsSection; children?: ReactNode; className?: string; disabled?: boolean }) {
  const show = useContext(SettingsContext);
  return <button type="button" className={className} disabled={disabled || !show} onClick={() => show?.(instance, section)}>{children}</button>;
}

/** 账号设置分类与模板类型保持挂载，避免切换丢失草稿。 */
function SettingsContent({ initialSection, onSaving, saving, onSectionChange }: { onSectionChange(value: SettingsSection): void; initialSection: SettingsSection; onSaving: (value: boolean) => void; saving: boolean }) {
  const section = initialSection === "chat" ? "ai" : initialSection === "video-profiles" ? "profiles" : initialSection;
  const [packageType, setPackageType] = useState(initialSection === "video-profiles" ? "video" : "live");
  const [mobileDetail, setMobileDetail] = useState(true);
  const settingsRoot = useRef<HTMLDivElement>(null);
  const packageScroll = useRef<Record<string, number>>({});
  /** 两类配置独立保留滚动位置，切换不会丢弃任何表单状态。 */
  function choosePackageType(value: string) {
    const body = settingsRoot.current?.querySelector<HTMLElement>('[data-state="active"] > .settings-panel-body');
    packageScroll.current[packageType] = body?.scrollTop || 0;
    setPackageType(value);
    requestAnimationFrame(() => { if (body) body.scrollTop = packageScroll.current[value] || 0; });
  }
  const detailHeading = useRef<HTMLHeadingElement>(null);
  /** 手机分类与详情切换后把焦点送入可见区域，避免停留在隐藏的导航按钮。 */
  function focusMobile(detail: boolean) {
    requestAnimationFrame(() => {
      if (!window.matchMedia("(max-width: 600px)").matches) return;
      if (detail) detailHeading.current?.focus();
      else settingsRoot.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  }
  return <Tabs orientation="vertical" value={section} onValueChange={value => { onSectionChange(value as SettingsSection); setMobileDetail(true); focusMobile(true); }} asChild><div ref={settingsRoot} className="api-settings" data-mobile-detail={mobileDetail}>
    <TabsList aria-label="设置分类"><TabsTrigger value="ai" disabled={saving} onClick={() => { setMobileDetail(true); focusMobile(true); }}>AI 服务</TabsTrigger><TabsTrigger value="defaults" disabled={saving} onClick={() => { setMobileDetail(true); focusMobile(true); }}>默认参数</TabsTrigger><TabsTrigger value="profiles" disabled={saving} onClick={() => { setMobileDetail(true); focusMobile(true); }}>发布配置</TabsTrigger></TabsList>
    <div className="settings-detail">
    <div className="settings-page-heading"><button type="button" className="btn-ghost settings-back" disabled={saving} onClick={() => { setMobileDetail(false); focusMobile(false); }}>返回分类</button><h3 ref={detailHeading} tabIndex={-1}>{section === "ai" ? "AI 服务" : section === "defaults" ? "默认参数" : "发布配置"}</h3></div>
    <SettingsPanel value="defaults"><BroadcastDefaultSettings onSaving={onSaving} /></SettingsPanel>
    <SettingsPanel value="profiles">
    <div className="publication-type" role="group" aria-label="配置包类型"><button type="button" aria-pressed={packageType === "live"} disabled={saving} onClick={() => choosePackageType("live")}>直播配置包</button><button type="button" aria-pressed={packageType === "video"} disabled={saving} onClick={() => choosePackageType("video")}>视频发布配置包</button></div>
    <div hidden={packageType !== "live"}><BroadcastProfileSettings onSaving={onSaving} /></div>
    <div hidden={packageType !== "video"}><PublishingProfileSettings onSaving={onSaving} /></div></SettingsPanel>
    <SettingsPanel value="ai"><ApiKeySettings onSaving={onSaving} /></SettingsPanel>
    </div>
  </div></Tabs>;
}
