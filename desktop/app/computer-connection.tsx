/** 电脑只配对一次：获取配对码与连接操作分组，连接后收为状态摘要。 */
"use client";
import type { ReactNode } from "react";
type Props = { online: boolean; paired: boolean; expired: boolean; configured: boolean; busy: boolean; invitation: string; onInvitation: (value: string) => void; onWeb: () => void; onPair: () => void; onReconnect: () => void; feedback: ReactNode };
/** 配对失败保留输入；已有连接只占一行，不重复要求每个 OBS 配对。 */
export default function ComputerConnection({ online, paired, expired, configured, busy, invitation, onInvitation, onWeb, onPair, onReconnect, feedback }: Props) {
  const form = <form className="pairing-form" onSubmit={event => { event.preventDefault(); if (!busy && configured && invitation.trim()) onPair(); }}>
    <label htmlFor="computer-pairing-code">粘贴配对码</label>
    <textarea id="computer-pairing-code" value={invitation} onChange={event => onInvitation(event.target.value)} rows={2} spellCheck={false} autoComplete="off" placeholder="在这里粘贴网页复制的完整配对码" aria-describedby="pairing-hint" disabled={busy} />
    <div className="pairing-submit"><p id="pairing-hint">{configured ? "配对后，这台电脑的所有 OBS 都会出现在网页。" : "先完成第 1 步，添加一个 OBS。"}</p><button type="submit" className="btn-primary" disabled={busy || !configured || !invitation.trim()}>{busy ? "正在处理…" : "连接这台电脑"}</button></div>
  </form>;
  return <section id="computer-connection" className={"computer-connection" + (online ? " is-connected" : "")} tabIndex={-1} aria-labelledby="connection-title">
    <div className="connection-heading"><span className="setup-step-index" aria-hidden="true">2</span><div><h2 id="connection-title">连接网页</h2><p>{online ? "这台电脑已连接。新增 OBS 无需再次配对。" : "一台电脑配对一次，所有 OBS 共用这次连接。"}</p></div>{!online && <span className="setup-state">{paired && !expired ? "正在连接" : "待完成"}</span>}</div>
    {!online && (!paired || expired ? <div className="pairing-layout"><div className="pairing-source"><h3>先在网页获取配对码</h3><p>打开工作台，在设备页面复制配对码，再回到这里粘贴。</p><button type="button" disabled={busy} onClick={onWeb}>打开网页工作台 ↗</button></div>{form}</div> : <div className="connection-recovery"><p role="status">已有配对保留，正在恢复连接。</p><button disabled={busy} onClick={onReconnect}>重新连接</button><details><summary>使用新的配对码</summary>{form}</details></div>)}
    {feedback}
  </section>;
}
