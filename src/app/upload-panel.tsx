/* 文件用途：LiveNest 媒体素材上传与分发中心，支持拖拽选择、断点续传查询、分片传输与 SHA-256 完整性校验。 */

"use client";

import { useEffect, useRef, useState, type FormEvent, type DragEvent } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import type { UploadStatus } from "@/shared/uploads";
import { targetKey } from "@/shared/remote";
import { api } from "./client-request";
import { identify, transfer, uploadUrl } from "./upload-client";
import {
  UploadIcon,
  VideoIcon,
  MusicIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  ServerIcon,
  RefreshIcon,
} from "./components/icons";

const KEY = "livepilot-upload";

/**
 * 格式化文件字节数为易读的 MiB 单位。
 *
 * @param value 字节数值
 * @returns 格式化后的容量字符串
 */
function bytes(value: number): string {
  return (value / 1024 ** 2).toFixed(1) + " MiB";
}

/**
 * LiveNest 媒体素材分发中心组件。
 *
 * @param props 包含可用实例列表的组件参数
 * @returns 素材上传面板 React 元素
 */
export default function UploadPanel({ instances }: { instances: InstanceDescriptor[] }) {
  const [record, setRecord] = useState<UploadStatus>();
  const [instanceId, setInstanceId] = useState(instances[0] ? targetKey(instances[0]) : "main");
  const [kind, setKind] = useState<"videos" | "music">("videos");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const createIntent = useRef<{ fingerprint: string; target: string; kind: string; requestId: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  /**
   * 记录并广播上传状态更新，完成时触发媒体库刷新。
   *
   * @param next 最新上传状态记录
   */
  function remember(next: UploadStatus) {
    setRecord(next);
    if (next.status === "complete") {
      window.dispatchEvent(new Event("livepilot-media-updated"));
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 禁用存储时本次上传仍可继续 */
    }
  }

  useEffect(() => {
    let active = true;

    /**
     * 恢复本地记录的未完成上传状态，不自动开始传输。
     */
    async function restore() {
      try {
        const saved = JSON.parse(localStorage.getItem(KEY) || "null") as UploadStatus | null;
        if (saved?.id && saved.instanceId) {
          const next = await api<UploadStatus>(uploadUrl(saved));
          if (active) {
            setRecord(next);
            setInstanceId(targetKey({ id: next.instanceId, agentId: next.agentId }));
            setKind(next.kind);
            setIsOpen(true);
          }
        }
      } catch {
        if (active) setError("之前的上传记录暂时不可用，可刷新或取消后重新上传。");
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
    let reading = false;

    /**
     * 校验阶段轮询服务器处理结果。
     */
    async function poll() {
      if (reading) return;
      reading = true;
      try {
        const next = await api<UploadStatus>(uploadUrl(current));
        remember(next);
        if (next.error) setError(next.error);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        reading = false;
      }
    }

    const timer = setInterval(() => void poll(), 3000);
    return () => clearInterval(timer);
  }, [record]);

  /**
   * 提交并开始分片上传流程。
   *
   * @param event 表单事件
   */
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setStage("正在计算文件 SHA-256 指纹…");

    try {
      const identity = await identify(file, controller.signal);
      let current = record;

      if (current) {
        current = await api<UploadStatus>(uploadUrl(current), { signal: controller.signal });
        if (current.size !== file.size || current.fingerprint !== identity.fingerprint) {
          throw new Error("所选文件与原上传不同，请选择原文件，或取消原上传后重新开始。");
        }
      } else {
        const destination = instances.find(i => targetKey(i) === instanceId);
        if (!destination) throw new Error("请重新选择目标直播电脑和实例。");

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
      setStage("正在高速传输到直播电脑…");

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

  /**
   * 重试完成校验。
   */
  async function retryFinish() {
    if (!record) return;
    setError("");
    try {
      remember(await api<UploadStatus>(uploadUrl(record, true), { method: "POST", headers: { "x-livepilot": "1" } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * 清理当前上传任务或本地缓存。
   */
  async function clear() {
    setError("");
    try {
      if (record) await api(uploadUrl(record), { method: "DELETE", headers: { "x-livepilot": "1" } });
      localStorage.removeItem(KEY);
      setRecord(undefined);
      setFile(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * 处理拖拽放置文件。
   */
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (busy || (record && record.status !== "uploading")) return;
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  }

  const progressPercent = record && record.size > 0 ? Math.min(100, Math.round((record.received / record.size) * 100)) : 0;

  return (
    <div className="media-dock-card">
      <div
        className="media-dock-summary"
        onClick={() => setIsOpen(!isOpen)}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div className="pipeline-icon-box" style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}>
            <UploadIcon />
          </div>
          <div>
            <span style={{ fontSize: "16px", fontWeight: 600 }}>媒体素材分发中枢</span>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 400 }}>
              上传音视频素材到目标直播电脑，自动校验并不中断正在进行的直播
            </p>
          </div>
        </div>

        <button type="button" className="btn-subtle" onClick={e => { e.stopPropagation(); setIsOpen(!isOpen); }}>
          {isOpen ? "收起面板" : "展开上传"}
        </button>
      </div>

      {isOpen && (
        <div className="media-dock-content">
          <form onSubmit={submit}>
            <div className="upload-form-grid">
              <div className="form-field">
                <label htmlFor="upload-instance" className="form-label">
                  <ServerIcon /> 目标直播电脑与实例
                </label>
                <select
                  id="upload-instance"
                  value={instanceId}
                  disabled={!!record || busy}
                  onChange={e => setInstanceId(e.target.value)}
                >
                  {instances.map(i => (
                    <option key={targetKey(i)} value={targetKey(i)}>
                      {i.agentName ? `${i.agentName} / ` : "本机 / "}
                      {i.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="upload-kind" className="form-label">
                  {kind === "videos" ? <VideoIcon /> : <MusicIcon />} 素材库分类
                </label>
                <select
                  id="upload-kind"
                  value={kind}
                  disabled={!!record || busy}
                  onChange={e => setKind(e.target.value as "videos" | "music")}
                >
                  <option value="videos">视频媒体库 (MP4, MKV, MOV, WEBM)</option>
                  <option value="music">音乐音频库 (MP3, WAV, FLAC, AAC)</option>
                </select>
              </div>

              <div
                className={`upload-file-dropzone ${isDragging ? "is-dragging" : ""}`}
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
              >
                <UploadIcon width={32} height={32} style={{ color: "var(--accent-emerald)" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
                    {file ? file.name : record?.status === "complete" ? "文件已成功加入素材库" : "点击选择文件或拖拽文件至此"}
                  </span>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    {file ? `${bytes(file.size)} · 准备就绪` : `支持 ${kind === "videos" ? "MP4, MKV, MOV, WEBM 等视频格式" : "MP3, WAV, FLAC, AAC 等音频格式"}`}
                  </span>
                </div>

                <input
                  id="upload-file"
                  type="file"
                  style={{ display: "none" }}
                  disabled={busy || (!!record && record.status !== "uploading")}
                  accept={kind === "videos" ? ".mp4,.mkv,.mov,.webm,.avi,.m4v" : ".mp3,.wav,.flac,.aac,.m4a,.ogg"}
                  onChange={e => setFile(e.target.files?.[0])}
                />
                <button
                  type="button"
                  className="btn-subtle"
                  disabled={busy || (!!record && record.status !== "uploading")}
                  onClick={() => document.getElementById("upload-file")?.click()}
                  style={{ marginTop: "8px" }}
                >
                  {file ? "重新选择" : "浏览本地文件"}
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
              {(!record || record.status === "uploading") && (
                <button
                  type="submit"
                  className="btn-primary-live"
                  disabled={!file || busy}
                  style={{ flex: "none", padding: "10px 24px" }}
                >
                  <UploadIcon />
                  {busy ? "正在传输…" : record ? "继续断点传输" : "开始传输至直播电脑"}
                </button>
              )}

              {busy && (
                <button type="button" className="btn-subtle" onClick={() => abort.current?.abort()}>
                  暂停传输
                </button>
              )}

              {!busy && record?.status === "verifying" && (
                <button type="button" className="btn-primary-live" onClick={() => void retryFinish()}>
                  <RefreshIcon /> 重试完成校验
                </button>
              )}

              {!busy && (record || file) && (
                <button type="button" className="btn-subtle" onClick={() => void clear()}>
                  {record?.status === "complete" ? "上传另一素材" : record ? "取消上传并清理" : "清除所选"}
                </button>
              )}
            </div>
          </form>

          {stage && (
            <p style={{ marginTop: "14px", fontSize: "13px", color: "var(--accent-cyan)" }} role="status">
              {stage}
            </p>
          )}

          {record && (
            <div className="upload-progress-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px" }}>
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{record.filename}</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                  {bytes(record.received)} / {bytes(record.size)} ({progressPercent}%)
                </span>
              </div>

              <div className="upload-progress-bar-wrap">
                <div className="upload-progress-bar-fill" style={{ width: `${progressPercent}%` }} />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                {record.status === "complete" ? (
                  <>
                    <CheckCircleIcon style={{ color: "#34d399" }} />
                    <span style={{ color: "#34d399" }}>已安全发布到素材库：{record.publishedName}</span>
                  </>
                ) : record.status === "verifying" ? (
                  <>
                    <RefreshIcon style={{ color: "#38bdf8" }} />
                    <span style={{ color: "#38bdf8" }}>正在由直播电脑进行哈希校验，关闭页面后台也会继续…</span>
                  </>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>分片进度已实时记录，可随时暂停或恢复。</span>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="alert-banner error" style={{ marginTop: "16px" }} role="alert">
              <AlertCircleIcon />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
