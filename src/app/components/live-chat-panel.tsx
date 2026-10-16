/** 频道互动的紧凑控制条；待机收起统计和记录，故障与恢复操作始终可见。 */
"use client";
import { useEffect, useState } from "react";
import { targetKey } from "@/shared/remote";
import { ApiSettingsButton } from "./api-settings";
import { api } from "../client-request";
import { defaultLiveChatConfig, liveChatConfigSchema, type LiveChatConfig, type LiveChatStatus } from "@/shared/live-chat";
import type { InstanceDescriptor } from "@/shared/types";
import styles from "./live-chat-panel.module.css";

const states: Record<LiveChatStatus["state"], string> = {
  disabled: "已关闭", needs_key: "AI 服务未就绪", waiting_live: "等待直播", connecting: "连接聊天中",
  running: "互动中", reconnecting: "正在重连", needs_attention: "需要处理", unavailable: "聊天不可用", quota_wait: "等待配额重置",
};
const entryStates = { queued: "排队中", sent: "已发送", skipped: "已跳过", uncertain: "发送结果待核对", failed: "回复失败" };
/** 开关立即保存；记录默认随运行状态展开，手动选择优先，错误与恢复始终可达。 */
export default function LiveChatPanel({ instance, status, supported, stale, onRefresh }: {
  instance: InstanceDescriptor; status?: LiveChatStatus; supported: boolean; stale: boolean; onRefresh: () => Promise<void> | void;
}) {
  const id = instance.agentId ? `${instance.agentId}-${instance.id}` : instance.id;
  const [savedStatus, setSavedStatus] = useState<LiveChatStatus>();
  const [working, setWorking] = useState<"" | "configure" | "read">("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recordsExpanded, setRecordsExpanded] = useState<boolean>();
  const current = savedStatus && (!status || savedStatus.updatedAt >= status.updatedAt) ? savedStatus : status;
  const recordsOpen = recordsExpanded ?? current?.state === "running";
  const canRequest = supported && !stale;
  const locked = !canRequest || !current || !!working;
  useEffect(() => {
    /** 设置保存回传公开状态，原面板下次启停必须使用新的人设与间隔。 */
    function updated(event: Event) { const detail = (event as CustomEvent<{ target: string; status: LiveChatStatus }>).detail; if (detail?.target === targetKey(instance)) setSavedStatus(detail.status); }
    window.addEventListener("livenest-chat-settings-saved", updated);
    return () => window.removeEventListener("livenest-chat-settings-saved", updated);
  }, [instance]);

  /** 所有请求显式定位目标 Agent 和实例，只读取公开状态或保存互动配置。 */
  async function request<T>(action: "read" | "configure", input?: { config: LiveChatConfig }) {
    return api<T>("/api/live-chat", {
      method: "POST", timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" },
      body: JSON.stringify({ action, instanceId: instance.id, ...(instance.agentId ? { agentId: instance.agentId } : {}), ...input }),
    });
  }

  /** 主控制台自行呈现读取失败，不将已成功的聊天保存误报为失败。 */
  function refreshDashboard() {
    try { void Promise.resolve(onRefresh()).catch(() => {}); } catch { /* 主控制台保留自己的离线提示。 */ }
  }

  /** 开关仅修改已保存配置的启停状态，不重置长期人设偏好。 */
  async function configure(next: LiveChatConfig) {
    if (locked) return;
    const parsed = liveChatConfigSchema.safeParse(next);
    if (!parsed.success) { setError("发送间隔请输入 5–60 的整数，人设描述最多 2000 字符。"); return; }
    setWorking("configure"); setError(""); setMessage("");
    try {
      const result = await request<LiveChatStatus>("configure", { config: parsed.data });
      setSavedStatus(result);
      setMessage(result.config.enabled ? "AI 互动已开启；条件就绪后自动回复新留言。" : "AI 互动已关闭，待回复队列已取消。");
      refreshDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : "保存未确认，请刷新互动状态后核对。"); }
    finally { setWorking(""); }
  }

  /** 过期时只刷新设备状态；连接有效时读取聊天公开状态，不直接连接 YouTube。 */
  async function readStatus() {
    if (!supported || working) return;
    setWorking("read"); setError(""); setMessage("");
    try {
      if (stale) await onRefresh();
      else { setSavedStatus(await request<LiveChatStatus>("read")); refreshDashboard(); }
    }
    catch (e) { setError(e instanceof Error ? e.message : "互动状态读取失败，请检查设备连接后重试。"); }
    finally { setWorking(""); }
  }

  /** 只展开当前实例的授权入口，不替用户执行 OAuth 同意或开播。 */
  function openChannelSettings() {
    const details = document.querySelector<HTMLDetailsElement>(`#instance-${CSS.escape(id)} .studio-connections`);
    if (details) { details.open = true; details.querySelector<HTMLButtonElement>(".conn-box:last-child button")?.focus(); details.scrollIntoView({ block: "nearest" }); }
  }

  return <section className={styles.panel} aria-labelledby={`chat-runtime-heading-${id}`}>
    <div className={styles.heading}>
      <h3 id={`chat-runtime-heading-${id}`}>AI 观众互动</h3>
      <div className={styles.controls}>
      <span className={`${styles.status} ${!stale && current?.state === "running" ? styles.running : ""}`}>{stale ? "当前状态未知" : !supported ? "需要升级" : current ? states[current.state] : "读取中"}</span>
        {supported && <button type="button" role="switch" aria-checked={current?.config.enabled ?? false} aria-label={`${instance.name} AI 自动回复观众${!current ? "，状态未读取" : stale ? "，上次状态" : ""}`} disabled={locked} className={`switch-btn ${current?.config.enabled ? "active" : ""}`} onClick={() => void configure({ ...(current?.config || defaultLiveChatConfig), enabled: !current?.config.enabled })}>
          <span className="switch-track" aria-hidden="true"><span /></span><span>{working === "configure" ? "保存中…" : !current ? "待读取" : stale ? "上次" + (current.config.enabled ? "开启" : "关闭") : current.config.enabled ? "开启" : "关闭"}</span>
        </button>}
      </div>
    </div>
    {!supported ? <p className={styles.notice}>请更新这台电脑的 LiveNest 客户端，再刷新互动状态。</p> : <>
      {stale && <p className={styles.notice} role="status">设备离线或状态已过期。以下为上次记录，重新连接后可修改。</p>}
      <div className={styles.runtime}>
        {!stale && (!current || current.message || current.state === "needs_key") && <p className={styles.hint} role="status">{current?.state === "needs_key" ? "请在 AI 服务设置中配置账号 Key 并开启观众互动，等待设备同步后刷新。" : current?.message || "正在读取互动状态…"}</p>}
        {!stale && current?.nextRetryAt !== undefined && <p className={styles.hint}>预计重试：<time dateTime={new Date(current.nextRetryAt).toISOString()}>{new Date(current.nextRetryAt).toISOString().slice(0, 19).replace("T", " ")} UTC</time></p>}
        {!stale && current?.recoveryAction === "authorize" && <div className={styles.actions}><button type="button" className="btn-ghost" onClick={openChannelSettings}>检查频道授权</button></div>}
        {!stale && current?.state === "needs_attention" && <div className={styles.actions}><button type="button" className="btn-secondary" disabled={locked || !current.config.enabled} onClick={() => void configure(current.config)}>重试互动</button><span className={styles.hint}>{current.recoveryAction === "check_storage" ? "先在直播电脑检查磁盘空间与目录权限。" : current.recoveryAction === "contact_admin" ? "请检查账号 AI 服务配置或余额后重试。" : "处理上方问题后，重新连接互动。"}</span></div>}
      </div>
      <div className={styles.toolbar}>
        <button type="button" className="btn-ghost" aria-expanded={recordsOpen} aria-controls={`chat-records-${id}`} onClick={() => setRecordsExpanded(!recordsOpen)}>活动记录{stale ? " · 上次记录" : ""}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" style={{ transform: recordsOpen ? "rotate(90deg)" : undefined }}><path d="m9 5 7 7-7 7" /></svg></button>
        <ApiSettingsButton instance={instance} section="ai" disabled={!!working}>AI 服务设置</ApiSettingsButton>
        <button type="button" className="btn-ghost" disabled={!!working} onClick={() => void readStatus()}>{working === "read" ? "读取中…" : stale ? "刷新设备状态" : "刷新互动状态"}</button>
      </div>
      <div className={styles.history} id={`chat-records-${id}`} hidden={!recordsOpen}>
        <dl className={styles.counts} aria-label="互动统计"><div><dt>已发送</dt><dd>{stale ? "—" : current?.sent ?? "—"}</dd></div><div><dt>已跳过</dt><dd>{stale ? "—" : current?.skipped ?? "—"}</dd></div><div><dt>排队中</dt><dd>{stale ? "—" : current?.queued ?? "—"}</dd></div></dl>
        {current?.recent.length ? <ol>{current.recent.slice(-30).reverse().map(entry => <li key={entry.id}><div className={styles.entryHeading}><strong>{entry.author || "观众"}</strong><span>{entryStates[entry.status]}</span></div><p>{entry.text}</p>{entry.reply && <p className={styles.reply}>{entry.reply}</p>}{entry.reason && <p className={styles.hint}>{entry.reason}</p>}</li>)}</ol> : <p className={styles.hint}>还没有互动记录；启用后只回复新留言。</p>}
      </div>
      {message && <p className={styles.feedback} role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    </>}
  </section>;
}
