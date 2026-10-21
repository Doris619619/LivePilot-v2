/* 文件用途：LiveNest 媒体素材分发抽屉，浅色紧凑设计，提供直观文件选取、断点续传与校验展示。 */

"use client";

import { useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { WorkbenchTransferContext } from "./components/workbench-context";
import type { InstanceDescriptor } from "@/shared/types";
import type { UploadStatus } from "@/shared/uploads";
import { targetKey } from "@/shared/remote";
import ProblemCard from "./components/problem-card";
import { makeProblem } from "../shared/problems";
import { api } from "./client-request";
import UploadRecovery, { type UploadOperation } from "./upload-recovery";
import FileDropzone from "./components/ui/file-dropzone";
import { Reveal, Progress } from "./components/ui/primitives";
import { identify, transfer, uploadUrl } from "./upload-client";
import { readUploadIntent, uploadIntentHandle, assertUploadIntent, type UploadIntent } from "./upload-intent";
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
/** 上传身份与素材类型不可被同一URL的异常响应替换；只允许服务端推进原记录的状态和偏移。 */
function assertUpload(expected: UploadStatus, next: UploadStatus) {
  if (expected.id !== next.id || expected.instanceId !== next.instanceId || expected.agentId !== next.agentId || expected.kind !== next.kind) throw new Error("上传记录与当前文件和目标不一致，请重新查询原电脑。");
}

/** 在选定直播电脑上传或恢复文件；上传进度不依赖面板展开状态。 */
export default function UploadPanel({ instances, channels, heading, request }: { instances: InstanceDescriptor[]; channels: Record<string, string>; heading?: ReactNode; request?: UploadRequest }) {
  const reportTransfer = useContext(WorkbenchTransferContext);
  const [record, setRecord] = useState<UploadStatus>();
  const [instanceId, setInstanceId] = useState(instances[0] ? targetKey(instances[0]) : "main");
  const [kind, setKind] = useState<"videos" | "music">("videos");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState(""); const [paused,setPaused]=useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [requestNotice, setRequestNotice] = useState("");
  const [lastRequest, setLastRequest] = useState(0);
  const [hasIntent, setHasIntent] = useState(false);

  const createIntent = useRef<UploadIntent | null>(null);
  const invalidIntent = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const operation = useRef({ generation: 0, active: false });
  const mounted = useRef(true);
  /** 所有显式上传操作在同一同步闸门串行，回执只可修改仍持有该代际的面板。 */
  const acquire = useCallback((): UploadOperation | undefined => {
    if (operation.current.active || !mounted.current) return;
    operation.current.active = true; const generation = ++operation.current.generation; setOperationBusy(true);
    const current = () => mounted.current && operation.current.active && operation.current.generation === generation;
    return { current, release: () => { if (current()) { operation.current.active = false; setOperationBusy(false); } } };
  }, []);
  /** 只消费一次入口请求；有文件、待确认创建或任务时保留原目标与进度。 */
  if (request && lastRequest !== request.sequence) {
    setLastRequest(request.sequence); setIsOpen(true); setRequestNotice("");
    if (busy || operationBusy || record || file || hasIntent) {
      if (request.target !== instanceId || request.kind !== kind) setRequestNotice("已保留当前上传，请先完成或取消，再添加到其他 OBS。");
    } else { setInstanceId(request.target); setKind(request.kind); }
  }
  useEffect(() => {
    if (!lastRequest) return;
    const panel = document.getElementById("upload-content"); panel?.focus({ preventScroll: true }); panel?.scrollIntoView({ block: "start" });
  }, [lastRequest]);

  /** 持续记录权威偏移并返回缓存落盘结果；只有替代记录可重读时才允许删除唯一旧恢复句柄。 */
  const remember = useCallback((next: UploadStatus) => {
    setRecord(next); if(next.error)setError(next.error);
    if (next.status === "complete") { setError("");
      window.dispatchEvent(new Event("livepilot-media-updated"));
    }
    try {
      const serialized = JSON.stringify(next); localStorage.setItem(KEY, serialized);
      return localStorage.getItem(KEY) === serialized;
    } catch {
      return false;
    }
  }, []);

  /** 从任一恢复入口同时切换目标、类型和进度；原 File 不能跨记录复用。 */
  const restoreRecord = useCallback((next: UploadStatus) => {
    if (createIntent.current && createIntent.current.requestId !== next.id) { setError("请先查询或取消当前待确认的上传，再恢复其他记录。"); setIsOpen(true); return; }
    if (createIntent.current) assertUploadIntent(createIntent.current, next);
    const persisted = remember(next); setError(next.error || "");
    setInstanceId(targetKey({ id: next.instanceId, agentId: next.agentId }));
    setKind(next.kind); setFile(undefined); setPaused(false); setRequestNotice(""); setIsOpen(true);
    if (persisted) {
      createIntent.current = null; setHasIntent(false);
      try { localStorage.removeItem(KEY + ".intent"); } catch { /* 替代记录已确认可重读，旧缓存残留仍使用同一身份恢复。 */ }
    } else if (createIntent.current) setRequestNotice("当前记录暂无法缓存，已保留原上传恢复句柄；刷新后可查询原上传。");
  }, [remember]);

  useEffect(() => {
    let active = true;
    const sessionOperation = operation.current;
    mounted.current = true;

    async function restore() {
      try {
        const pending = localStorage.getItem(KEY + ".intent");
        if (pending) {
          invalidIntent.current = true; setHasIntent(true); setIsOpen(true);
          createIntent.current = readUploadIntent(JSON.parse(pending)); invalidIntent.current = false;
          setInstanceId(createIntent.current.target); setKind(createIntent.current.kind); setFile(undefined);
        }
        setHasIntent(!!createIntent.current);
        const saved = JSON.parse(localStorage.getItem(KEY) || "null") as UploadStatus | null;
        if (createIntent.current && saved?.id !== createIntent.current.requestId) return;
        if (saved?.id && saved.instanceId) {
          const lease = acquire(); if (!lease) return;
          try { const next = await api<UploadStatus>(uploadUrl(saved)); assertUpload(saved, next); if (active && lease.current()) restoreRecord(next); }
          finally { lease.release(); }
        }
      } catch {
        if (active) setError(invalidIntent.current ? "原上传恢复句柄无法读取，请保留浏览器缓存并联系管理员核对；尚未创建其他上传。" : "历史上传记录暂不可用");
      }
    }

    void restore();
    return () => {
      active = false;
      mounted.current = false; sessionOperation.generation++; sessionOperation.active = false;
      abort.current?.abort();
    };
  }, [restoreRecord, acquire]);

  useEffect(() => {
    if (record?.status !== "verifying") return;
    const current = record;
    let reading = false; let active=true;

    async function poll() {
      if (reading || operation.current.active) return;
      const generation = operation.current.generation;
      reading = true;
      try {
        const next = await api<UploadStatus>(uploadUrl(current));
        if(!active || operation.current.active || generation !== operation.current.generation)return; assertUpload(current, next); remember(next);
        setError(next.error || "");
      } catch (e) {
        if(active && !operation.current.active && generation === operation.current.generation)setError((e as Error).message);
      } finally {
        reading = false;
      }
    }

    const timer = setInterval(() => void poll(), 3000);
    return () => {active=false;clearInterval(timer);};
  }, [record, remember]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    const lease = acquire(); if (!lease) return;

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);setPaused(false);
    setError("");
    setStage("正在检查文件…");

    try {
      if (invalidIntent.current) throw new Error("原上传恢复句柄无效，请先联系管理员核对，不能覆盖原创建意图。");
      const identity = await identify(file, controller.signal);
      let current = record;

      if (current) {
        current = await api<UploadStatus>(uploadUrl(current), { signal: controller.signal });
        assertUpload(record!, current);
        if (current.size !== file.size || current.fingerprint !== identity.fingerprint) {
          throw new Error("所选文件与原上传不一致");
        }
      } else {
        if (createIntent.current && (createIntent.current.fingerprint !== identity.fingerprint || createIntent.current.target !== instanceId || createIntent.current.kind !== kind)) throw new Error("所选文件或目标与原上传不一致，请先查询或取消原上传；恢复句柄已保留。");
        const destination = instances.find(i => targetKey(i) === instanceId);
        if (!destination) throw new Error("原上传目标暂不可用，请查询原上传或等待原电脑恢复，不能改到其他目标。");

        if (!createIntent.current) {
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
        assertUploadIntent(createIntent.current, current);
      }

      if (!lease.current()) return; remember(current);
      setStage("正在上传…");

      if (current.status === "uploading") {
        const expected = current;
        await transfer(file, current, identity.hashes, controller.signal, next => { assertUpload(expected, next); if (lease.current()) remember(next); });
      }
    } catch (e) {
      if (lease.current()) setError((e as Error).message);
    } finally {
      if (lease.current()) { setBusy(false); setStage(""); } lease.release();
    }
  }

  async function retryFinish() {
    if (!record) return;
    const lease = acquire(); if (!lease) return;
    setError("");
    try {
      const next = await api<UploadStatus>(uploadUrl(record, true), { method: "POST", headers: { "x-livepilot": "1" } }); assertUpload(record, next); if (lease.current()) remember(next);
    } catch (e) {
      if (lease.current()) setError((e as Error).message);
    } finally { lease.release(); }
  }
  /** 手工核对与续传/恢复共用闸门，迟到旧查询不能替换新会话。 */
  async function queryRecord() {
    if (!record) return; const lease = acquire(); if (!lease) return;
    try { const next = await api<UploadStatus>(uploadUrl(record)); assertUpload(record, next); if (lease.current()) remember(next); }
    catch (e) { if (lease.current()) setError((e as Error).message); }
    finally { lease.release(); }
  }
  /** 创建回执丢失时直接核对原幂等句柄；失败不改变目标、类型或缓存，成功才转换为记录会话。 */
  async function queryIntent() {
    const lease = acquire(); if (!lease) return;
    try {
      if (invalidIntent.current || !createIntent.current) throw new Error("原上传恢复句柄暂不可用，请保留缓存并联系管理员核对。");
      const intent = createIntent.current, next = await api<UploadStatus>(uploadUrl(uploadIntentHandle(intent))); assertUploadIntent(intent, next);
      if (lease.current()) restoreRecord(next);
    } catch (e) { if (lease.current()) setError((e as Error).message); }
    finally { lease.release(); }
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

  /** 关闭已完成记录只结束面板会话；未完成取消必须先取得原设备的权威确认。 */
  async function clear() {
    const lease = acquire(); if (!lease) return;
    setError("");
    try {
      if (invalidIntent.current) throw new Error("原上传恢复句柄无效，取消尚未确认；请保留缓存并联系管理员核对。");
      if (record?.status === "complete") { dismiss(); return; }
      if (record) await api(uploadUrl(record), { method: "DELETE", headers: { "x-livepilot": "1" } });
      else if (createIntent.current) {
        await api(uploadUrl(uploadIntentHandle(createIntent.current)), { method: "DELETE", headers: { "x-livepilot": "1" } });
      }
      if (lease.current()) dismiss();
    } catch (e) {
      if (lease.current()) setError((e as Error).message);
    } finally { lease.release(); }
  }

  /** 清理当前显示及本地幂等意图；存储受限不能阻止用户离开已完成的会话。 */
  function dismiss() {
    try { localStorage.removeItem(KEY); localStorage.removeItem(KEY + ".intent"); } catch { /* 已确认终态的本地显示仍可关闭。 */ }
    createIntent.current = null; invalidIntent.current = false; setHasIntent(false); setRequestNotice(""); setRecord(undefined); setFile(undefined); setPaused(false);
  }

  const destination = instances.find(i => targetKey(i) === instanceId);
  const activeKind = record?.kind || kind;
  const destinationLabel = destination ? `${channels[instanceId] || destination.name} · ${destination.agentName || "本机"} / ${destination.name}` : "原上传目标暂不可用";
  const progressLabel = record?.status === "complete" ? "上传完成" : record?.status === "verifying" ? record.verification === "failed" ? "校验未完成，需要处理" : "正在校验文件…" : busy ? stage : "等待继续上传";
  const transferLabel = error ? "上传需要处理" : record?.status === "complete" ? "上传完成" : record?.status === "verifying" ? "正在校验" : busy ? "正在上传" : "上传已暂停";
  const transferName = record?.filename || file?.name || "素材上传";
  const transferPercent = record?.status === "uploading" ? Math.floor(record.received / Math.max(1, record.size) * 100) : undefined;
  const hasTransfer = busy || !!record;
  /** 常驻侧栏只接收公开进度；切换模块不改变请求、文件或上传控制器。 */
  useEffect(() => { reportTransfer?.(hasTransfer ? { filename: transferName, label: transferLabel, percent: transferPercent } : undefined); }, [reportTransfer, hasTransfer, transferName, transferLabel, transferPercent]);
  useEffect(() => {
    const show = () => setIsOpen(true);
    window.addEventListener("livenest-open-upload", show);
    return () => { window.removeEventListener("livenest-open-upload", show); reportTransfer?.(undefined); };
  }, [reportTransfer]);
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
          {record || busy || hasIntent ? <p className="upload-destination"><DeviceIcon /><span>{destinationLabel}</span><span>{activeKind === "videos" ? "视频" : "音乐"}</span></p> : <div className="form-row">
            <div className="field-group">
              <label htmlFor="upload-instance" className="field-label">上传到</label>
              <select id="upload-instance" disabled={operationBusy} value={instanceId} onChange={e => setInstanceId(e.target.value)}>
                {instances.map(i => <option key={targetKey(i)} value={targetKey(i)}>{channels[targetKey(i)] || i.name} · {i.agentName || "本机"} / {i.name}</option>)}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="upload-kind" className="field-label">素材类型</label>
              <select id="upload-kind" disabled={operationBusy} value={kind} onChange={e => { setKind(e.target.value as "videos" | "music"); setFile(undefined); }}>
                <option value="videos">视频</option><option value="music">音乐</option>
              </select>
            </div>
          </div>}
          {!busy && (!record || record.status === "uploading") && <FileDropzone id="upload-file" label={record ? "重新选择同一文件" : file ? "更换文件" : activeKind === "videos" ? "选择视频文件" : "选择音乐文件"} name={file?.name} hint={record ? "选择原文件后继续上传" : activeKind === "videos" ? "MP4、MKV、MOV、WEBM 等 · 文件发送到所选直播电脑" : "MP3、WAV、FLAC、AAC 等 · 文件发送到所选直播电脑"} disabled={operationBusy} accept={activeKind === "videos" ? { "video/*": [".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"] } : { "audio/*": [".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"] }} onFile={setFile} />}
          {record ? <div className="upload-progress">
            <div className="upload-progress-title"><strong>{record.filename}</strong><span role="status">{progressLabel}</span></div>
            <Progress aria-label="素材上传进度" value={record.received / Math.max(1, record.size) * 100} />
            <div className="upload-progress-meta"><span>{bytes(record.received)} / {bytes(record.size)}</span><span>{Math.floor(record.received / Math.max(1, record.size) * 100)}%</span></div>
            {record.status === "complete" ? <p className="upload-success"><CheckCircleIcon />已添加到素材库，可回到下方选择使用。</p> : <p className="upload-hint">{record.status === "verifying" ? record.verification === "failed" ? "文件已传完，但尚未发布。请查看原因后重新提交校验；文件损坏时取消此上传并重传。" : "文件已传完，正在确认完整性。" : "支持暂停，稍后可继续上传。"}</p>}
          </div> : busy && <p className="upload-hint" role="status">{stage}</p>}
          <div className="upload-actions">{!busy && record?.status==="verifying" && <button type="button" disabled={operationBusy} onClick={() => void queryRecord()}>查询校验状态</button>}
            {!busy && !record && hasIntent && <button type="button" disabled={operationBusy} onClick={() => void queryIntent()}>查询原上传</button>}
            {!busy && (!record || record.status === "uploading") && <button type="submit" className="btn-primary" disabled={!file || operationBusy}><UploadIcon />{record || hasIntent ? "继续上传" : "开始上传"}</button>}
            {busy && <button type="button" className="btn-secondary" onClick={() => {setPaused(true);abort.current?.abort();}}>暂停上传</button>}
            {!busy && record?.status === "verifying" && (record.verification==="failed" || !!record.error) && <button type="button" className="btn-secondary" disabled={operationBusy} onClick={() => void retryFinish()}><RefreshIcon />重新提交校验</button>}
            {!busy && (record || file || hasIntent) && <button type="button" className={record?.status === "complete" ? "btn-primary" : "btn-ghost"} disabled={operationBusy} onClick={() => void clear()}>{record?.status === "complete" ? "上传下一个" : record || hasIntent ? "取消上传" : "清除选择"}</button>}
          </div>
        </form>
        {error && <ProblemCard objectName={destinationLabel} problem={record?.problem || makeProblem(paused?"CANCELLED":"UPLOAD",error,{domain:"media",target:{agentId:record?.agentId,instanceId:record?.instanceId,uploadId:record?.id},stage:"上传素材"})} onRefresh={record ? () => void queryRecord() : undefined} />}
        <UploadRecovery key={instanceId} agentId={destination?.agentId} instanceId={destination?.id || "main"} currentId={record?.id} disabled={operationBusy || hasIntent} acquire={acquire} restore={restoreRecord} cancelled={cancelled} />
      </div></Reveal>
    </section>
  );
}
