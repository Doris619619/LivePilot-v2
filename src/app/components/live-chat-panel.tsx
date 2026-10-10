/** 展示每个频道的 AI 观众互动，独立保存设置，不占用开停播表单的锁。 */
"use client";
import { useState } from "react";
import { api } from "../client-request";
import { defaultLiveChatConfig, liveChatConfigSchema, type LiveChatConfig, type LiveChatStatus } from "@/shared/live-chat";
import type { InstanceDescriptor } from "@/shared/types";
import styles from "./live-chat-panel.module.css";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/primitives";

const states: Record<LiveChatStatus["state"], string> = {
  disabled: "已关闭", needs_key: "环境未就绪", waiting_live: "等待直播", connecting: "连接聊天中",
  running: "互动中", reconnecting: "正在重连", needs_attention: "需要处理", unavailable: "聊天不可用", quota_wait: "等待配额重置",
};
const entryStates = { queued: "排队中", sent: "已发送", skipped: "已跳过", uncertain: "发送结果待核对", failed: "回复失败" };
type Draft = Omit<LiveChatConfig, "enabled">;

/** 只显示公开聊天状态；开关立即保存，风格草稿由用户显式保存，直播期间均可操作。 */
export default function LiveChatPanel({ instance, status, supported, stale, onRefresh }: {
  instance: InstanceDescriptor; status?: LiveChatStatus; supported: boolean; stale: boolean; onRefresh: () => Promise<void> | void;
}) {
  const id = instance.agentId ? `${instance.agentId}-${instance.id}` : instance.id;
  const [savedStatus, setSavedStatus] = useState<LiveChatStatus>();
  const [draft, setDraft] = useState<Draft>();
  const [intervalText, setIntervalText] = useState<string>();
  const [working, setWorking] = useState<"" | "configure" | "read">("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const current = savedStatus && (!status || savedStatus.updatedAt >= status.updatedAt) ? savedStatus : status;
  const config = { ...(current?.config || defaultLiveChatConfig), ...draft };
  const canRequest = supported && !stale;
  const locked = !canRequest || !current || !!working;
  const dirty = !!draft || intervalText !== undefined;

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

  /** 保存完整配置；开关只修改已保存的启停状态，保留尚未保存的人设草稿。 */
  async function configure(next: LiveChatConfig, clearDraft: boolean) {
    if (locked) return;
    const parsed = liveChatConfigSchema.safeParse(next);
    if (!parsed.success) { setError("发送间隔请输入 5–60 的整数，人设描述最多 2000 字符。"); return; }
    setWorking("configure"); setError(""); setMessage("");
    try {
      const result = await request<LiveChatStatus>("configure", { config: parsed.data });
      setSavedStatus(result);
      if (clearDraft) { setDraft(undefined); setIntervalText(undefined); }
      setMessage(clearDraft ? "互动设置已保存，直播期间立即生效。" : result.config.enabled ? "AI 互动已开启；条件就绪后自动回复新留言。" : "AI 互动已关闭，待回复队列已取消。");
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

  /** 将人设变化留在当前面板草稿，状态轮询不会覆盖用户正在编辑的内容。 */
  function edit(next: Partial<Draft>) {
    setDraft({ preset: config.preset, customPrompt: config.customPrompt, intervalSeconds: config.intervalSeconds, ...next });
  }

  /** 只展开当前实例的授权入口，不替用户执行 OAuth 同意或开播。 */
  function openChannelSettings() {
    const details = document.querySelector<HTMLDetailsElement>(`#instance-${CSS.escape(id)} .studio-connections`);
    if (details) { details.open = true; details.querySelector<HTMLButtonElement>(".conn-box:last-child button")?.focus(); details.scrollIntoView({ block: "nearest" }); }
  }

  return <section className={styles.panel} aria-labelledby={`chat-heading-${id}`}>
    <div className={styles.heading}>
      <div><h3 id={`chat-heading-${id}`}>AI 观众互动</h3><p>由直播电脑运行，关闭网页后继续互动。</p></div>
      <span className={`${styles.status} ${!stale && current?.state === "running" ? styles.running : ""}`}>{stale ? "当前状态未知" : !supported ? "需要升级" : current ? states[current.state] : "读取中"}</span>
    </div>
    {!supported ? <p className={styles.notice}>这台直播电脑的 Agent 暂不支持 AI 观众互动，请升级 Agent 后刷新状态。</p> : <>
      {stale && <p className={styles.notice} role="status">设备离线或状态已过期，当前互动状态未知。以下显示上次记录，重新连接后再调整设置。</p>}
      <Tabs defaultValue="settings"><TabsList aria-label="AI 互动视图"><TabsTrigger value="settings">互动设置</TabsTrigger><TabsTrigger value="activity">活动记录</TabsTrigger></TabsList><TabsContent value="settings" className={styles.tabContent}>
      <div className={styles.topRow}>
        <div><strong>自动回复观众</strong><p className={styles.hint}>默认开启；直播电脑环境就绪、频道开播且聊天可用时自动工作。</p></div>
        <button type="button" role="switch" aria-checked={current?.config.enabled ?? true} aria-label={`${instance.name} AI 自动回复观众`} disabled={locked} className={`switch-btn ${(current?.config.enabled ?? true) ? "active" : ""}`} onClick={() => void configure({ ...(current?.config || defaultLiveChatConfig), enabled: !current?.config.enabled }, false)}>
          <span className="switch-track" aria-hidden="true"><span /></span><span>{working === "configure" ? "保存中…" : (current?.config.enabled ?? true) ? "开启" : "关闭"}</span>
        </button>
      </div>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void configure({ ...config, intervalSeconds: Number(intervalText ?? config.intervalSeconds) }, true); }}>
        <div className={styles.fields}>
          <div className={styles.field}><label htmlFor={`chat-preset-${id}`}>互动人设</label><select id={`chat-preset-${id}`} disabled={locked} value={config.preset} onChange={event => edit({ preset: event.target.value as LiveChatConfig["preset"] })}><option value="friendly">友善陪聊</option><option value="playful">活泼幽默</option><option value="gentle">安静温柔</option><option value="custom">自定义</option></select></div>
          <div className={styles.field}><label htmlFor={`chat-interval-${id}`}>发送间隔（秒）</label><input id={`chat-interval-${id}`} type="number" inputMode="numeric" required min={5} max={60} step={1} disabled={locked} value={intervalText ?? config.intervalSeconds} onChange={event => setIntervalText(event.target.value)} aria-describedby={`chat-interval-hint-${id}`} /><span className={styles.hint} id={`chat-interval-hint-${id}`}>5–60 秒，默认 5 秒</span></div>
        </div>
        <div className={styles.field}><label htmlFor={`chat-prompt-${id}`}>{config.preset === "custom" ? "自定义人设描述" : "补充人设描述（可选）"}</label><textarea id={`chat-prompt-${id}`} rows={3} maxLength={2000} disabled={locked} value={config.customPrompt} onChange={event => edit({ customPrompt: event.target.value })} placeholder="例如：像温柔的电台主持人一样陪大家聊天，回答简短自然。" aria-describedby={`chat-prompt-hint-${id}`} /><span className={styles.hint} id={`chat-prompt-hint-${id}`}>始终跟随观众留言的语言，欢迎首次发言者；回复包含 [AI] 和观众称呼，最多 200 字符。</span></div>
        <div className={styles.actions}><button type="submit" className="btn-secondary" disabled={locked || !dirty}>{working === "configure" ? "保存中…" : "保存互动设置"}</button><span className={styles.hint}>{dirty ? "有尚未保存的设置" : "设置按频道实例保存，跨场次和重启保留"}</span></div>
      </form>
      </TabsContent><TabsContent value="activity" className={styles.tabContent}>
      <div className={styles.runtime}>
        <div className={styles.runtimeHeading}><h4>互动状态</h4><button type="button" className="btn-ghost" disabled={!!working} onClick={() => void readStatus()}>{working === "read" ? "读取中…" : stale ? "刷新设备状态" : "刷新互动状态"}</button></div>
        <p className={styles.hint} role="status">{stale ? "当前状态未知；发送数量及互动记录是上次设备报告。" : current?.state === "needs_key" ? "直播电脑的 DeepSeek 环境配置未就绪，请联系管理员" : current?.message || "正在读取直播电脑的互动状态。"}</p>
        {!stale && current?.nextRetryAt !== undefined && <p className={styles.hint}>预计重试：<time dateTime={new Date(current.nextRetryAt).toISOString()}>{new Date(current.nextRetryAt).toISOString().slice(0, 19).replace("T", " ")} UTC</time></p>}
        {!stale && current?.state === "needs_attention" && <div className={styles.actions}><button type="button" className="btn-ghost" onClick={openChannelSettings}>检查频道授权</button></div>}
        <dl className={styles.counts}><div><dt>已发送</dt><dd>{stale ? "—" : current?.sent ?? "—"}</dd></div><div><dt>已跳过</dt><dd>{stale ? "—" : current?.skipped ?? "—"}</dd></div><div><dt>排队中</dt><dd>{stale ? "—" : current?.queued ?? "—"}</dd></div></dl>
        <p className={styles.hint}>每日回复条数无上限，仍受 DeepSeek 余额和 YouTube 项目共享配额限制。队列最多 100 条，超过 2 分钟或溢出的旧留言会跳过。<a href="https://developers.google.com/youtube/v3/determine_quota_cost" target="_blank" rel="noopener noreferrer">查看配额说明</a></p>
      </div>
      <section className={styles.history}><h4>最近 30 条互动{stale ? " · 上次记录" : ""}</h4>{current?.recent.length ? <ol>{current.recent.slice(-30).reverse().map(entry => <li key={entry.id}><div className={styles.entryHeading}><strong>{entry.author || "观众"}</strong><span>{entryStates[entry.status]}</span></div><p>{entry.text}</p>{entry.reply && <p className={styles.reply}>{entry.reply}</p>}{entry.reason && <p className={styles.hint}>{entry.reason}</p>}</li>)}</ol> : <p className={styles.hint}>还没有互动记录；启用后只回复新留言。</p>}</section>
      </TabsContent></Tabs>
      {message && <p className={styles.feedback} role="status">{message}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    </>}
  </section>;
}
