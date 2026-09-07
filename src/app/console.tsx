/** 浅色多实例控制台外壳；实例清单没有固定数量上限。 */
"use client";
import { useEffect, useState } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import InstanceConsole from "./instance-console";

/** 加载公开实例清单，将每个实例交给独立面板管理。 */
export default function Console() {
  const [instances, setInstances] = useState<InstanceDescriptor[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 页面只读取配置清单，不在挂载时启动 OBS 或直播。 */
  useEffect(() => {
    const abort = new AbortController();
    /** 读取 OAuth 安全提示与实例清单；未配置完成时给出真实错误。 */
    async function load() {
      const cookie = document.cookie.split("; ").find(v => v.startsWith("livepilot_notice="));
      if (cookie) {
        setNotice(decodeURIComponent(cookie.slice("livepilot_notice=".length)));
        document.cookie = "livepilot_notice=; Max-Age=0; Path=/; SameSite=Strict";
      }
      try {
        const response = await fetch("/api/instances", { signal: abort.signal, cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "无法读取实例配置");
        setInstances(result.instances);
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "请检查本机服务"); }
    }
    void load();
    return () => abort.abort();
  }, []);
  return <main>
    <header className="masthead"><div><p className="eyebrow">LOCAL BROADCAST CONTROL</p><h1>LivePilot<span>.</span></h1><p className="intro">选好内容，让每个频道各自开播。</p></div><div className="local-label"><span className="dot on" />本机控制台<span className="instance-count">{instances.length} 个 OBS 实例</span></div></header>
    <div className="page-heading"><h2>直播工作台</h2><p>每个 OBS 连接一个 YouTube 频道，独立开始与结束。</p></div>
    {(error || notice) && <p className="notice error" role="alert">{error || notice}</p>}
    {!instances.length && !error && <p role="status">正在读取本机实例…</p>}
    <div className="instance-grid">{instances.map(instance => <InstanceConsole key={instance.id} instance={instance} />)}</div>
    <footer><span>LivePilot v2 / 本机 OBS 直接推流到 YouTube</span><span>添加实例：编辑 .env.local 后重启服务</span></footer>
  </main>;
}
