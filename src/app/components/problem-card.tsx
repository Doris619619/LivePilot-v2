/** 网页与桌面共用就地恢复卡；只有调用方提供的白名单动作可以执行。 */
"use client";
import { useState } from "react";
import { guidance, problemSummary, type Problem, type ProblemAction } from "../../shared/problems";
type Props = { problem: Problem; objectName?: string; disabled?: boolean; onRefresh?: () => void; onLogin?: () => void; onAuthorize?: () => void; onSettings?: () => void; onHelp?: () => void };
/** 客户步骤始终可见，技术摘要可复制，远程设置入口只显示本机操作说明。 */
export default function ProblemCard({ problem, objectName, disabled, onRefresh, onLogin, onAuthorize, onSettings, onHelp }: Props) {
  const [copied, setCopied] = useState("");
  const info = guidance(problem);
  const handlers: Partial<Record<ProblemAction, (() => void) | undefined>> = { login:onLogin, refresh:onRefresh, authorize:onAuthorize, settings:onSettings, help:onHelp };
  const labels: Partial<Record<ProblemAction,string>> = { login:"重新登录", refresh:problem.stage === "读取本机状态" ? "重新读取" : problem.attemptId ? "查询本次操作" : "重新检查", authorize:"重新授权原频道", settings:"查看连接设置", help:"查看对应步骤" };
  /** 复制失败只影响复制提示，不覆盖原故障。 */
  async function copy() { try { if (window.liveNest?.copyProblem) { if (!await window.liveNest.copyProblem(problem)) throw new Error(); } else await navigator.clipboard.writeText(problemSummary(problem)); setCopied("摘要已复制，请交给管理员"); } catch { setCopied("无法自动复制，请复制下方诊断信息"); } }
  return <section className={"problem-card " + problem.severity} role={problem.severity === "info" ? "status" : "alert"}>
    <strong>{objectName && objectName + " · "}{info.title}</strong>
    <p>{problem.message}</p>
    <p className="problem-stage">{problem.stage} · {{"not-sent":"请求未发出",rejected:"本次请求未完成",accepted:"请求已受理",completed:"操作已完成",partial:"部分完成",unknown:"结果待核对"}[problem.outcome]}</p>
    <ol>{info.steps.map(step => <li key={step}>{step}</li>)}</ol>
    <div className="problem-actions">{problem.actions.filter(action=>handlers[action]).map(action=><button type="button" key={action} disabled={disabled} onClick={handlers[action]}>{labels[action]}</button>)}<button type="button" onClick={()=>void copy()}>复制诊断摘要</button></div>
    {copied && <p role="status">{copied}</p>}
    <details><summary>诊断信息</summary><code>{problemSummary(problem)}</code></details>
  </section>;
}
