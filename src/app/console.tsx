/* 文件用途：LiveNest 多实例直播控制台中枢，汇总管理多台直播电脑与所有 OBS 实例状态。 */

"use client";

import { useEffect, useState } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import UploadPanel from "./upload-panel";
import { targetKey, type AgentDescriptor } from "@/shared/remote";
import { api } from "./client-request";
import InstanceConsole from "./instance-console";
import { ServerIcon, AlertCircleIcon, RefreshIcon } from "./components/icons";

/**
 * LiveNest 多实例多电脑直播控制台主视图。
 *
 * @returns 控制台页面 React 元素
 */
export default function Console() {
  const [instances, setInstances] = useState<InstanceDescriptor[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[] | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const abort = new AbortController();

    /**
     * 读取通知 Cookie 与实例清单。
     */
    async function load() {
      const cookie = document.cookie.split("; ").find(v => v.startsWith("livepilot_notice="));
      if (cookie) {
        setNotice(decodeURIComponent(cookie.slice("livepilot_notice=".length)));
        document.cookie = "livepilot_notice=; Max-Age=0; Path=/; SameSite=Strict";
      }
      try {
        const result = await api<{ instances: InstanceDescriptor[]; agents?: AgentDescriptor[] }>("/api/instances", {
          signal: abort.signal,
        });
        setInstances(result.instances);
        setAgents(result.agents);
        setLoaded(true);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : "无法连接至 LiveNest 控制服务，请检查网络或服务状态");
        }
      }
    }

    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, []);

  const onlineAgentsCount = agents ? agents.filter(a => a.online && !a.revoked).length : 1;

  return (
    <main className="app-container">
      {/* 顶部 Hero 区域 */}
      <header className="console-hero">
        <div className="hero-main">
          <h1>
            Live<span style={{ color: "var(--accent-emerald)" }}>Nest</span> 控制中心
          </h1>
          <p className="hero-desc">
            专业多频道分布式直播调度台。为每个 Windows OBS 实例指定循环素材，独立向 YouTube 发起高质量推流。
          </p>
        </div>

        <div className="hero-stats-row">
          <div className="stat-chip">
            <ServerIcon />
            <span>在线发射机:</span>
            <strong>{onlineAgentsCount}</strong>
          </div>

          <div className="stat-chip">
            <span className="dot on" />
            <span>已配置实例:</span>
            <strong>{instances.length}</strong>
          </div>
        </div>
      </header>

      {/* 全局错误与通告条 */}
      {(error || notice) && (
        <div className="alert-banner error" role="alert">
          <AlertCircleIcon />
          <span>{error || notice}</span>
        </div>
      )}

      {/* 加载状态 */}
      {!loaded && !error && (
        <div className="stat-chip" style={{ width: "fit-content", margin: "32px auto" }}>
          <RefreshIcon style={{ animation: "spin 1s linear infinite" }} />
          <span role="status">正在同步 LiveNest 实例遥测数据…</span>
        </div>
      )}

      {/* 空实例状态 */}
      {loaded && !instances.length && (
        <div className="media-dock-card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <ServerIcon width={48} height={48} style={{ color: "var(--text-muted)", margin: "0 auto 16px" }} />
          <h3 style={{ fontSize: "18px", marginBottom: "8px" }}>尚无已连接的 OBS 直播实例</h3>
          <p style={{ fontSize: "14px", color: "var(--text-muted)", maxWidth: "480px", margin: "0 auto" }}>
            请在 Windows 直播电脑上完成 LiveNest Agent 配对并启动服务，或在本机配置文件中添加实例定义。
          </p>
        </div>
      )}

      {/* 素材分发中心 */}
      {!!instances.length && <UploadPanel instances={instances} />}

      {/* 实例网格列表 */}
      {agents ? (
        agents
          .filter(a => !a.revoked)
          .map(agent => {
            const agentInstances = instances.filter(i => i.agentId === agent.id);
            return (
              <section key={agent.id} className="agent-group-section" aria-label={agent.name}>
                <div className="agent-group-header">
                  <div className="agent-group-title">
                    <ServerIcon />
                    <span>{agent.name}</span>
                    <span className={`agent-status-tag ${agent.online ? "online" : "offline"}`}>
                      <span className="dot" />
                      {agent.online ? "在线通信中" : "离线"}
                    </span>
                  </div>

                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    {agent.lastSeen
                      ? `最近心跳 ${new Date(agent.lastSeen).toLocaleTimeString("zh-CN", { hour12: false })}`
                      : "等待首次心跳"}
                  </span>
                </div>

                <div className="instance-grid">
                  {agentInstances.map(instance => (
                    <InstanceConsole key={targetKey(instance)} instance={instance} />
                  ))}
                </div>
              </section>
            );
          })
      ) : (
        <div className="instance-grid">
          {instances.map(instance => (
            <InstanceConsole key={targetKey(instance)} instance={instance} />
          ))}
        </div>
      )}

      {/* 页脚说明 */}
      <footer className="app-footer">
        <span>LiveNest Studio Operations · 直播电脑直接推流至 YouTube 平台</span>
        <span>{agents ? "已下发的广播任务由对应发射机独立执行" : "如需扩展实例，编辑本机配置后重启服务"}</span>
      </footer>
    </main>
  );
}
