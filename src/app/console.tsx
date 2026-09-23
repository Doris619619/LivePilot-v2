/* 文件用途：组织设备导航、实例工作区和素材上传，并区分加载、空数据与连接失败。 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import UploadPanel, { type UploadRequest } from "./upload-panel";
import { targetKey, type AgentDescriptor } from "@/shared/remote";
import { api } from "./client-request";
import InstanceConsole from "./instance-console";
import DevicePairing from "./device-pairing";
import DeviceRemove from "./device-remove";
import { AlertCircleIcon, DeviceIcon, RefreshIcon, VideoIcon } from "./components/icons";

/** 轮询设备清单；导航使用页内定位，保留实例草稿和正在进行的上传。 */
export default function Console() {
  const [channels, setChannels] = useState<Record<string, string>>({});
  const [uploadRequest, setUploadRequest] = useState<UploadRequest>();
  /** 从空素材入口带入目标 OBS 和素材类型，不替换上传面板已有任务。 */
  const openUpload = useCallback((target: string, kind: "videos" | "music") => {
    setUploadRequest(previous => ({ target, kind, sequence: (previous?.sequence || 0) + 1 }));
  }, []);
  /** 以设备与实例的稳定组合键共享频道名；名称变化不改变上传或控制目标。 */
  const updateChannel = useCallback((key: string, channel: string) => {
    setChannels(previous => {
      if ((previous[key] || "") === channel) return previous;
      const next = { ...previous };
      if (channel) next[key] = channel;
      else delete next[key];
      return next;
    });
  }, []);
  const [instances, setInstances] = useState<InstanceDescriptor[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[] | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let reading = false;
    /** 同一轮不重叠请求；失败保留已有列表并提示状态可能过期。 */
    async function load() {
      if (reading) return;
      reading = true;
      const cookie = document.cookie.split("; ").find(v => v.startsWith("livepilot_notice="));
      if (cookie) {
        setNotice(decodeURIComponent(cookie.slice("livepilot_notice=".length)));
        document.cookie = "livepilot_notice=; Max-Age=0; Path=/; SameSite=Strict";
      }
      try {
        const result = await api<{ instances: InstanceDescriptor[]; agents?: AgentDescriptor[] }>("/api/instances", { signal: abort.signal });
        if (abort.signal.aborted) return;
        const chosen=new URLSearchParams(window.location.search).get("customer");
        const visible=chosen?result.agents?.filter(a=>a.owner===chosen):result.agents;
        setInstances(chosen?result.instances.filter(i=>visible?.some(a=>a.id===i.agentId)):result.instances);
        setAgents(visible);
        setLoaded(true);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "无法连接至控制服务");
      } finally { reading = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [refreshKey]);

  // 未完成的邀请留在配对入口，不冒充另一台已接入的电脑。
  const devices = agents?.filter(a => !a.revoked && a.paired !== false);

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar" aria-label="工作台导航">
        <a className="sidebar-link is-active" href="#workspace"><VideoIcon /><span>直播工作台</span><span className="nav-count">{loaded ? instances.length : "—"}</span></a>
        <div className="sidebar-heading device-heading">直播设备</div>
        <nav aria-label="设备定位">
          {devices ? devices.map(agent => (
            <a key={agent.id} className="sidebar-link" href={"#device-" + agent.id}>
              <DeviceIcon /><span>{agent.name}</span><span className={"device-dot " + (agent.online ? "online" : "")} aria-label={agent.online ? "在线" : "离线"} />
            </a>
          )) : loaded && <a className="sidebar-link" href="#device-local"><DeviceIcon /><span>本机设备</span></a>}
          {loaded && !devices?.length && agents && <p className="sidebar-hint">尚未接入设备</p>}
          {!loaded && <p className="sidebar-hint">{error ? "设备列表暂不可用" : "正在读取设备…"}</p>}
        </nav>
        {agents && <DevicePairing agents={agents} />}
      </aside>

      <main className="main-wrapper" id="workspace" tabIndex={-1}>
        {instances.length ? <UploadPanel instances={instances} channels={channels} request={uploadRequest} heading={<h1>直播工作台</h1>} /> : <div className="workspace-heading"><h1>直播工作台</h1></div>}

        {error && <div className="banner error" role="alert"><AlertCircleIcon /><span>{error}{loaded ? " 当前显示上次获取的设备列表。" : ""}</span><button type="button" onClick={() => setRefreshKey(v => v + 1)}>重试连接</button></div>}
        {notice && <div className="banner warning" role="status"><AlertCircleIcon /><span>{notice}</span><button type="button" onClick={() => setNotice("")}>关闭提示</button></div>}
        {!loaded && !error && <div className="empty-state" role="status"><RefreshIcon /><h2>正在读取工作台</h2><p>同步设备与实例状态…</p></div>}
        {loaded && !instances.length && !devices?.length && !error && <div className="empty-state"><div className="empty-icon"><DeviceIcon width={28} height={28} /></div><h2>连接直播电脑</h2><p>点击“添加直播电脑”，复制配对码到 LiveNest。<br />连接后，直播实例会自动出现在这里。</p><button type="button" onClick={() => setRefreshKey(v => v + 1)}><RefreshIcon />刷新设备</button></div>}
        {devices ? devices.map(agent => {
          const agentInstances = instances.filter(i => i.agentId === agent.id);
          return (
            <section className="device-section" id={"device-" + agent.id} key={agent.id} aria-label={agent.name}>
              <DeviceRemove agent={agent} changed={() => setRefreshKey(v => v + 1)}><h2><DeviceIcon />{agent.name}<span className={"device-state " + (agent.online ? "online" : "")}>{agent.maintenance ? "维护中" : agent.paired === false ? "等待配对" : agent.online ? "在线" : "离线"}</span></h2></DeviceRemove>
              <div className="instance-grid">{agentInstances.map(instance => <InstanceConsole key={targetKey(instance)} instance={instance} onChannelChange={updateChannel} onUpload={openUpload} />)}</div>
              {!agentInstances.length && <p className="device-empty">设备尚未上报直播实例。</p>}
            </section>
          );
        }) : <section className="device-section" id="device-local" aria-label="本机设备"><div className="instance-grid">{instances.map(instance => <InstanceConsole key={targetKey(instance)} instance={instance} onChannelChange={updateChannel} onUpload={openUpload} />)}</div></section>}
      </main>
    </div>
  );
}
