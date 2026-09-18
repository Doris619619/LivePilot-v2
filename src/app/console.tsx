/* 文件用途：LiveNest 广播控制台中枢，纯净浅色界面、清晰结构与零视觉噪音。 */

"use client";

import { useEffect, useState } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import UploadPanel from "./upload-panel";
import { targetKey, type AgentDescriptor } from "@/shared/remote";
import { api } from "./client-request";
import InstanceConsole from "./instance-console";
import { AlertCircleIcon, DeviceIcon, RefreshIcon } from "./components/icons";

export default function Console() {
  const [instances, setInstances] = useState<InstanceDescriptor[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[] | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const abort = new AbortController();

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
          setError(e instanceof Error ? e.message : "无法连接至控制服务");
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
    <main className="main-wrapper">
      {/* 顶部概览栏 */}
      <div className="overview-bar">
        <div className="overview-title">
          <h1>LiveNest 广播控制台</h1>
          <p>多频道 OBS 独立推流与媒体调度工作台</p>
        </div>

        <div className="overview-stats">
          <div className="metric-badge">
            <DeviceIcon />
            <span>在线设备:</span>
            <strong>{onlineAgentsCount}</strong>
          </div>
          <div className="metric-badge">
            <span>实例总数:</span>
            <strong>{instances.length}</strong>
          </div>
        </div>
      </div>

      {(error || notice) && (
        <div className="banner error" role="alert">
          <AlertCircleIcon />
          <span>{error || notice}</span>
        </div>
      )}

      {!loaded && !error && (
        <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)", fontSize: "13px" }}>
          <RefreshIcon /> 同步实例状态中…
        </div>
      )}

      {loaded && !instances.length && (
        <div style={{ textAlign: "center", padding: "40px", background: "var(--surface-base)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)" }}>
          <DeviceIcon width={32} height={32} style={{ color: "var(--text-muted)", margin: "0 auto 8px" }} />
          <h3 style={{ fontSize: "15px", marginBottom: "4px" }}>暂无连接的直播实例</h3>
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>请在直播电脑上启动 LiveNest Agent 或配置本地实例。</p>
        </div>
      )}

      {!!instances.length && <UploadPanel instances={instances} />}

      {agents ? (
        agents
          .filter(a => !a.revoked)
          .map(agent => {
            const agentInstances = instances.filter(i => i.agentId === agent.id);
            return (
              <section key={agent.id} style={{ marginBottom: "28px" }} aria-label={agent.name}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", padding: "0 4px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: 600 }}>
                    <DeviceIcon />
                    <span>{agent.name}</span>
                    <span style={{ fontSize: "12px", fontWeight: 500, color: agent.online ? "var(--success-green)" : "var(--text-muted)" }}>
                      {agent.online ? "● 在线" : "○ 离线"}
                    </span>
                  </div>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    {agent.lastSeen ? `最近心跳: ${new Date(agent.lastSeen).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
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

      <footer className="app-footer">
        <span>LiveNest Studio Operations</span>
        <span>Windows OBS → YouTube 独立直连推流</span>
      </footer>
    </main>
  );
}
