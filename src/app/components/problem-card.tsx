/** 网页与桌面共用就地恢复卡；只有调用方提供的白名单动作可以执行。 */
"use client";
import { useState } from "react";
import { guidance, problemSummary, type Problem, type ProblemAction } from "../../shared/problems";
import { problemPresentation } from "../../shared/problem-policy";
type Props = { problem: Problem; objectName?: string; disabled?: boolean; onRefresh?: () => void; onLogin?: () => void; onAuthorize?: () => void; onSettings?: () => void; onHelp?: () => void };
/** 客户问题仅显示事实与操作；非阻塞检查只进入折叠的技术报告。 */
export default function ProblemCard({ problem, objectName, disabled, onRefresh, onLogin, onAuthorize, onSettings, onHelp }: Props) {
  const [copied, setCopied] = useState("");
  const info = guidance(problem);
  const presentation = problemPresentation(problem);
  const handlers: Partial<Record<ProblemAction, (() => void) | undefined>> = { login:onLogin, refresh:onRefresh, authorize:onAuthorize, settings:onSettings, help:onHelp };
  const labels: Partial<Record<ProblemAction,string>> = { login:"重新登录", refresh:problem.stage === "读取本机状态" ? "重新读取" : problem.attemptId ? "查询本次操作" : "重新检查", authorize:"重新授权原频道", settings:"查看连接设置", help:"查看对应步骤" };
  /** 复制失败只影响复制提示，不覆盖原故障。 */
  async function copy() { try { if (window.liveNest?.copyProblem) { if (!await window.liveNest.copyProblem(problem)) throw new Error(); } else await navigator.clipboard.writeText(problemSummary(problem)); setCopied("摘要已复制，请交给管理员"); } catch { setCopied("无法自动复制，请复制下方诊断信息"); } }
  const report = <details className="technical-report"><summary>技术报告{presentation === "technical" ? " · " + (objectName || "本机") : ""}</summary><p>{info.title} · {problem.stage} · {new Date(problem.observedAt).toLocaleString()}</p><p>{problem.message}</p><code>{problemSummary(problem)}</code><div><button type="button" onClick={()=>void copy()}>复制脱敏报告</button></div>{copied && <p role="status">{copied}</p>}</details>;
  if (presentation === "technical") return report;
  if (presentation === "status") return <div className="operation-status" role="status">{objectName && objectName + " · "}{info.title}</div>;
  const customerMessage = ({ OBS_PORT: "控制连接被其他程序占用，请检查此 OBS 的连接设置。", OBS_NOT_LISTENING: "OBS 已运行，但控制服务尚未启用或连接设置不一致。", OBS_AUTH: "控制密码不匹配，请核对此 OBS 的连接设置。" } as Record<string, string>)[problem.code] || problem.message;
  return <section className="problem-card error" role="alert">
    <strong>{objectName && objectName + " · "}{info.title}</strong>
    <p>{customerMessage}</p>
    {problem.outcome === "unknown" && <p>结果尚未确认，请先查询，避免重复操作。</p>}
    <p>{info.steps[0]}</p>
    <div className="problem-actions">{problem.actions.filter(action=>handlers[action]).map(action=><button type="button" key={action} disabled={disabled} onClick={handlers[action]}>{labels[action]}</button>)}</div>
    {report}
  </section>;
}
