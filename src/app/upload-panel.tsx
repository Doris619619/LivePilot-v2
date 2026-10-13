/* 文件用途：LiveNest 媒体素材分发抽屉，浅色紧凑设计，提供直观文件选取、断点续传与校验展示。 */

"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import type { UploadStatus } from "@/shared/uploads";
import { targetKey } from "@/shared/remote";
import ProblemCard from "./components/problem-card";
import { makeProblem } from "../shared/problems";
import { api } from "./client-request";
import UploadRecovery from "./upload-recovery";
import FileDropzone from "./components/ui/file-dropzone";
import { Reveal, Progress } from "./components/ui/primitives";
import { identify, transfer, uploadUrl } from "./upload-client";
import {
  UploadIcon,
  CheckCircleIcon,
  RefreshIcon,
  DeviceIcon,
} from "./components/icons";

const KEY = "livepilot-upload";
export type UploadRequest = { target: string; kind: "videos" | "music"; sequence: number };

/** 将上传字节数格式化为可比较的 MiB 数值。 */
function bytes(value: number): string {
  return (value / 1024 ** 2).toFixed(1) + " MiB";
}

/** 在选定直播电脑上传或恢复文件；上传进度不依赖面板展开状态。 */
export default function UploadPanel({ instances, channels, heading, request }: { instances: InstanceDescriptor[]; channels: Record<string, string>; heading?: ReactNode; request?: UploadRequest }) {
  const [record, setRecord] = useState<UploadStatus>();
  const [instanceId, setInstanceId] = useState(instances[0] ? targetKey(instances[0]) : "main");
  const [kind, setKind] = useState<"videos" | "music">("videos");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState(""); const [paused,setPaused]=useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [requestNotice, setRequestNotice] = useState("");
  const [lastRequest, setLastRequest] = useState(0);
  const [hasIntent, setHasIntent] = useState(false);

  const createIntent = useRef<{ fingerprint: string; target: string; kind: string; requestId: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** 只消费一次入口请求；有文件、待确认创建或任务时保留原目标与进度。 */
  if (request && lastRequest !== request.sequence) {
    setLastRequest(request.sequence); setIsOpen(true); setRequestNotice("");
    if (busy || record || file || hasIntent) {
      if (request.target !== instanceId || request.kind !== kind) setRequestNotice("已保留当前上传，请先完成或取消，再添加到其他 OBS。");
    } else { setInstanceId(request.target); setKind(request.kind); }
  }
  useEffect(() => {
    if (!lastRequest) return;
    const panel = document.getElementById("upload-content"); panel?.focus({ preventScroll: true }); panel?.scrollIntoView({ block: "start" });
  }, [lastRequest]);

  function remember(next: UploadStatus) {
    setRecord(next); if(next.error)setError(next.error);
    if (next.status === "complete") { setError("");
      window.dispatchEvent(new Event("livepilot-media-updated"));
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 忽略存储异常 */
    }
  }

  useEffect(() => {
    let active = true;

    async function restore() {
      try {
        createIntent.current = JSON.parse(localStorage.getItem(KEY + ".intent") || "null");
        setHasIntent(!!createIntent.current);
        const saved = JSON.parse(localStorage.getItem(KEY) || "null") as UploadStatus | null;
        if (saved?.id && saved.instanceId) {
          const next = await api<UploadStatus>(uploadUrl(saved));
          if (active) {
            setRecord(next);setError(next.error || "");
            setInstanceId(targetKey({ id: next.instanceId, agentId: next.agentId }));
            setKind(next.kind);
            setIsOpen(true);
          }
        }
      } catch {
        if (active) setError("历史上传记录暂不可用");
      }
    }

    void restore();
    return () => {
      active = false;
      abort.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (record?.status !== "verifying") return;
    const current = record;
    let reading = false; let active=true;

    async function poll() {
      if (reading) return;
      reading = true;
      try {
        const next = await api<UploadStatus>(uploadUrl(current));
        if(!active)return;remember(next);
        setError(next.error || "");
      } catch (e) {
        if(active)setError((e as Error).message);
      } finally {
        reading = false;
      }
    }

    const timer = setInterval(() => void poll(), 3000);
    return () => {active=false;clearInterval(timer);};
  }, [record]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);setPaused(false);
    setError("");
    setStage("正在检查文件…");

    try {
      const identity = await identify(file, controller.signal);
      let current = record;

      if (current) {
        current = await api<UploadStatus>(uploadUrl(current), { signal: controller.signal });
        if (current.size !== file.size || current.fingerprint !== identity.fingerprint) {
          throw new Error("所选文件与原上传不一致");
        }
      } else {
        const destination = instances.find(i => targetKey(i) === instanceId);
        if (!destination) throw new Error("目标实例不存在");

        if (
          !createIntent.current ||
          createIntent.current.fingerprint !== identity.fingerprint ||
          createIntent.current.target !== instanceId ||
          createIntent.current.kind !== kind
        ) {
          createIntent.current = {
            fingerprint: identity.fingerprint,
            target: instanceId,
            kind,
            requestId: crypto.randomUUID(),
          };
        }

        // 创建前持久化幂等身份；响应丢失或刷新后仍复用同一请求。
        localStorage.setItem(KEY + ".intent", JSON.stringify(createIntent.current));
        setHasIntent(true);
        current = await api<UploadStatus>("/api/uploads", {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", "x-livepilot": "1" },
          body: JSON.stringify({
            instanceId: destination.id,
            agentId: destination.agentId,
            requestId: createIntent.current.requestId,
            kind,
            filename: file.name,
            size: file.size,
            fingerprint: identity.fingerprint,
          }),
        });
      }

      remember(current);
      setStage("正在上传…");

      if (current.status === "uploading") {
        await transfer(file, current, identity.hashes, controller.signal, remember);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  async function retryFinish() {
    if (!record) return;
    setError("");
    try {
      remember(await api<UploadStatus>(uploadUrl(record, true), { method: "POST", headers: { "x-livepilot": "1" } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** 服务端确认取消后只清理匹配的记录，其他上传和用户新选的文件保持不变。 */
  function cancelled(id: string) {
    if (record?.id === id) { setRecord(undefined); setFile(undefined); }
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null") as UploadStatus | null;
      if (saved?.id === id) localStorage.removeItem(KEY);
      if (createIntent.current?.requestId === id) { createIntent.current = null; setHasIntent(false); localStorage.removeItem(KEY + ".intent"); }
    } catch { /* 服务端取消已确认，缓存失败不影响真实结果。 */ }
  }

  async function clear() {
    setError("");
    try {
      if (record) await api(uploadUrl(record), { method: "DELETE", headers: { "x-livepilot": "1" } });
      else if (createIntent.current) {
        const destination = instances.find(i => targetKey(i) === createIntent.current!.target);
        if (!destination) throw new Error("原上传目标暂不可用，请查询未结束的上传后处理。");
        await api(uploadUrl({ id: createIntent.current.requestId, instanceId: destination.id, agentId: destination.agentId }), { method: "DELETE", headers: { "x-livepilot": "1" } });
      }
      localStorage.removeItem(KEY); localStorage.removeItem(KEY + ".intent"); createIntent.current = null;
      setHasIntent(false); setRequestNotice("");
      setRecord(undefined);
      setFile(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const destination = instances.find(i => targetKey(i) === instanceId);
  const destinationLabel = destination ? `${channels[instanceId] || destination.name} · ${destination.agentName || "本机"} / ${destination.name}` : "原上传目标暂不可用";
  const progressLabel = record?.status === "complete" ? "上传完成" : record?.status === "verifying" ? record.verification === "failed" ? "校验未完成，需要处理" : "正在校验文件…" : busy ? stage : "等待继续上传";
  return (
    <section className="media-dock" aria-label="素材上传">
      <div className="dock-header">
        <div className="dock-heading">{heading || <h2>素材库</h2>}</div>
        <button type="button" className="btn-secondary" aria-expanded={isOpen} aria-controls="upload-content" onClick={() => setIsOpen(!isOpen)}>
          <UploadIcon />{isOpen ? "收起上传" : "上传素材"}
        </button>
      </div>
      {!isOpen && (error || (record && record.status !== "complete")) && <div className="instance-feedback" role="status">{record?.filename || "素材上传"} · {error ? "需要处理" : busy ? "传输中" : record?.verification === "failed" ? "校验未完成" : record?.status === "verifying" ? "正在校验" : "已暂停"}<button onClick={()=>setIsOpen(true)}>查看进度与处理步骤</button></div>}
      <Reveal open={isOpen}><div className="dock-content" id="upload-content" tabIndex={-1}>
        {requestNotice && <p className="upload-hint" role="status">{requestNotice}</p>}
        <form onSubmit={submit}>
          {record || busy ? <p className="upload-destination"><DeviceIcon /><span>{destinationLabel}</span><span>{kind === "videos" ? "视频" : "音乐"}</span></p> : <div className="form-row">
            <div className="field-group">
              <label htmlFor="upload-instance" className="field-label">上传到</label>
              <select id="upload-instance" value={instanceId} onChange={e => setInstanceId(e.target.value)}>
                {instances.map(i => <option key={targetKey(i)} value={targetKey(i)}>{channels[targetKey(i)] || i.name} · {i.agentName || "本机"} / {i.name}</option>)}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="upload-kind" className="field-label">素材类型</label>
              <select id="upload-kind" value={kind} onChange={e => { setKind(e.target.value as "videos" | "music"); setFile(undefined); }}>
                <option value="videos">视频</option><option value="music">音乐</option>
              </select>
            </div>
          </div>}
          {!busy && (!record || record.status === "uploading") && <FileDropzone id="upload-file" label={record ? "重新选择同一文件" : file ? "更换文件" : kind === "videos" ? "选择视频文件" : "选择音乐文件"} name={file?.name} hint={record ? "选择原文件后继续上传" : kind === "videos" ? "MP4、MKV、MOV、WEBM 等 · 文件发送到所选直播电脑" : "MP3、WAV、FLAC、AAC 等 · 文件发送到所选直播电脑"} accept={kind === "videos" ? { "video/*": [".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"] } : { "audio/*": [".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"] }} onFile={setFile} />}
          {record ? <div className="upload-progress">
            <div className="upload-progress-title"><strong>{record.filename}</strong><span role="status">{progressLabel}</span></div>
            <Progress aria-label="素材上传进度" value={record.received / Math.max(1, record.size) * 100} />
            <div className="upload-progress-meta"><span>{bytes(record.received)} / {bytes(record.size)}</span><span>{Math.floor(record.received / Math.max(1, record.size) * 100)}%</span></div>
            {record.status === "complete" ? <p className="upload-success"><CheckCircleIcon />已添加到素材库，可回到下方选择使用。</p> : <p className="upload-hint">{record.status === "verifying" ? record.verification === "failed" ? "文件已传完，但尚未发布。请查看原因后重新提交校验；文件损坏时取消此上传并重传。" : "文件已传完，正在确认完整性。" : "支持暂停，稍后可继续上传。"}</p>}
          </div> : busy && <p className="upload-hint" role="status">{stage}</p>}
          <div className="upload-actions">{!busy && record?.status==="verifying" && <button type="button" onClick={()=>void api<UploadStatus>(uploadUrl(record)).then(remember,e=>setError(e.message))}>查询校验状态</button>}
            {!busy && (!record || record.status === "uploading") && <button type="submit" className="btn-primary" disabled={!file}><UploadIcon />{record ? "继续上传" : "开始上传"}</button>}
            {busy && <button type="button" className="btn-secondary" onClick={() => {setPaused(true);abort.current?.abort();}}>暂停上传</button>}
            {!busy && record?.status === "verifying" && (record.verification==="failed" || !!record.error) && <button type="button" className="btn-secondary" onClick={() => void retryFinish()}><RefreshIcon />重新提交校验</button>}
            {!busy && (record || file || hasIntent) && <button type="button" className={record?.status === "complete" ? "btn-primary" : "btn-ghost"} onClick={() => void clear()}>{record?.status === "complete" ? "上传下一个" : record || hasIntent ? "取消上传" : "清除选择"}</button>}
          </div>
        </form>
        {error && <ProblemCard objectName={destinationLabel} problem={record?.problem || makeProblem(paused?"CANCELLED":"UPLOAD",error,{domain:"media",target:{agentId:record?.agentId,instanceId:record?.instanceId,uploadId:record?.id},stage:"上传素材"})} onRefresh={record ? ()=>void api<UploadStatus>(uploadUrl(record)).then(remember,e=>setError(e.message)) : undefined} />}
        <UploadRecovery key={instanceId} agentId={destination?.agentId} instanceId={destination?.id || "main"} currentId={record?.id} disabled={busy} restore={remember} cancelled={cancelled} />
      </div></Reveal>
    </section>
  );
}
