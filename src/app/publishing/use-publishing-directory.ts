/** 提前读取所选电脑的固定发布目录；不依赖发布账号，也不触发上传或 OAuth。 */
"use client";
import { useEffect, useState } from "react";
import { api, RequestError } from "../client-request";
type Target = { agentId: string; instanceId: string };
type Directory = { target: string; attempt: number; root: string; message: string };
/** 复用现有发布包 RPC 只取 root；切换电脑忽略旧响应，离线重读等待真实目录。 */
export function usePublishingDirectory(target: Target | undefined, accepted: boolean) {
  const [directory, setDirectory] = useState<Directory>(); const [attempt, setAttempt] = useState(0);
  const agentId = target?.agentId; const instanceId = target?.instanceId;
  const key = accepted && agentId && instanceId ? agentId + ":" + instanceId : "";
  useEffect(() => {
    if (!key) return;
    const abort = new AbortController(); let cancelled = false; let retry: ReturnType<typeof setTimeout> | undefined;
    /** 只保留目录响应；后台初读不会把素材清单或其他账号的扫描结果写进向导。 */
    async function read() {
      try {
        const result = await api<{ root: string }>("/api/publishing", { method: "POST", timeoutMs: 60000, signal: abort.signal, headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ action: "packages", agentId, instanceId }) });
        if (!cancelled) setDirectory({ target: key, attempt, root: result.root, message: "" });
      } catch (error) {
        if (cancelled) return;
        const offline = error instanceof RequestError && error.problem.code === "AGENT_OFFLINE";
        setDirectory({ target: key, attempt, root: "", message: offline ? "电脑离线，待设备上线后显示目录。" : "暂时无法读取目录，请重试。" });
        if (offline) retry = setTimeout(() => void read(), 10000);
      }
    }
    void read();
    return () => { cancelled = true; abort.abort(); if (retry) clearTimeout(retry); };
  }, [key, agentId, instanceId, attempt]);
  const current = directory?.target === key && directory.attempt === attempt ? directory : undefined;
  return { root: current?.root || "", reading: !!key && !current, message: !accepted ? "同意并继续后，自动读取这台电脑的目录。" : current?.message || "正在读取这台电脑的目录…", retry: () => setAttempt(value => value + 1) };
}
