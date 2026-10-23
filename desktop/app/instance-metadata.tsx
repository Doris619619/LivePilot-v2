/** 实例显示名称和安全退休入口：名称失败回滚，退休保留原文件与授权。 */
"use client";
import { useState } from "react";
import type { DesktopAction, PublicInstance } from "../../src/shared/desktop";
type Props = { instance: PublicInstance; disabled: boolean; act(action: DesktopAction, input: Record<string, unknown>): Promise<boolean> };
/** 失焦只提交名称元数据；失败后恢复宿主已保存值，不展示伪成功名称。 */
export function InstanceName({ instance, disabled, act }: Props) {
  const [draft, setDraft] = useState<string>(); const [saving, setSaving] = useState(false);
  /** 空名称恢复原值，异步提交期间禁止再次编辑同一字段。 */
  async function save() {
    const name = draft?.trim(); if (!name || name === instance.name) { setDraft(undefined); return; }
    setSaving(true);
    try { await act("rename", { id: instance.id, name }); } finally { setDraft(undefined); setSaving(false); }
  }
  return <label className="field-group">实例名称<input name="name" autoComplete="off" aria-label={instance.name + "名称"} disabled={disabled || saving} value={draft ?? instance.name} maxLength={80} onChange={event => setDraft(event.target.value)} onBlur={() => void save()} />{saving && <span role="status">正在保存名称…</span>}</label>;
}
/** 二次明确确认仅用于退出活跃清单；服务端和本机仍会核对真实空闲状态。 */
export function InstanceRetirement({ instance, disabled, act }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  if (instance.id === "main") return null;
  return <details><summary>退役此 OBS</summary><p>退役后不再接受直播任务，频道可交给其他实例。程序、素材、授权与历史保留；有未结束的场次或任务时不会执行。</p><label><input name="retirementConfirmed" autoComplete="off" type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />确认将 {instance.name} 移出活跃清单</label><button disabled={disabled || !confirmed} onClick={() => void act("retire", { id: instance.id, confirmed: true })}>确认退役</button></details>;
}
