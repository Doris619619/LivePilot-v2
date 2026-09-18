/* 文件用途：LiveNest 媒体素材分发抽屉，浅色紧凑设计，提供直观文件选取、断点续传与校验展示。 */

"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
  RefreshIcon,
  DeviceIcon,
} from "./components/icons";

const KEY = "livepilot-upload";

/** 将上传字节数格式化为可比较的 MiB 数值。 */
function bytes(value: number): string {
  return (value / 1024 ** 2).toFixed(1) + " MiB";
}

/** 在选定直播电脑上传或恢复文件；上传进度不依赖面板展开状态。 */
export default function UploadPanel({ instances, channels, heading }: { instances: InstanceDescriptor[]; channels: Record<string, string>; heading?: ReactNode }) {
  const [record, setRecord] = useState<UploadStatus>();
  const [instanceId, setInstanceId] = useState(instances[0] ? targetKey(instances[0]) : "main");
  const [kind, setKind] = useState<"videos" | "music">("videos");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const createIntent = useRef<{ fingerprint: string; target: string; kind: string; requestId: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  function remember(next: UploadStatus) {
    setRecord(next);
    if (next.status === "complete") {
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
    let reading = false;

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setStage("计算文件指纹…");

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
      setStage("分片传输中…");

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

  return (
    <section className="media-dock" aria-label="素材上传">
      <div className="dock-header">
        <div className="dock-heading">{heading || <h2>素材库</h2>}</div>
        <button type="button" className="btn-secondary" aria-expanded={isOpen} aria-controls="upload-content" onClick={() => setIsOpen(!isOpen)}>
          <UploadIcon />{isOpen ? "收起上传" : "上传素材"}
        </button>
      </div>

      {isOpen && (
        <div className="dock-content" id="upload-content">
          <form onSubmit={submit}>
            <div className="form-row">
              <div className="field-group">
                <label htmlFor="upload-instance" className="field-label">
                  <DeviceIcon /> 目标实例
                </label>
                <select
                  id="upload-instance"
                  value={instanceId}
                  disabled={!!record || busy}
                  onChange={e => setInstanceId(e.target.value)}
                >
                  {instances.map(i => (
                    <option key={targetKey(i)} value={targetKey(i)}>
                      {channels[targetKey(i)] || i.name} · {i.agentName || "本机"} / {i.name} ({i.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group">
                <label htmlFor="upload-kind" className="field-label">
                  {kind === "videos" ? <VideoIcon /> : <MusicIcon />} 素材类型
                </label>
                <select
                  id="upload-kind"
                  value={kind}
                  disabled={!!record || busy}
                  onChange={e => setKind(e.target.value as "videos" | "music")}
                >
                  <option value="videos">视频 (MP4, MKV, MOV, WEBM)</option>
                  <option value="music">音乐 (MP3, WAV, FLAC, AAC)</option>
                </select>
              </div>

              <div className="field-group" style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="upload-file" className="field-label">
                  选择文件
                </label>
                <input
                  id="upload-file"
                  type="file"
                  disabled={busy || (!!record && record.status !== "uploading")}
                  accept={kind === "videos" ? ".mp4,.mkv,.mov,.webm,.avi,.m4v" : ".mp3,.wav,.flac,.aac,.m4a,.ogg"}
                  onChange={e => setFile(e.target.files?.[0])}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              {(!record || record.status === "uploading") && (
                <button type="submit" className="btn-primary" disabled={!file || busy} style={{ flex: "none" }}>
                  <UploadIcon />
                  <span>{busy ? "传输中…" : record ? "继续传输" : "开始上传"}</span>
                </button>
              )}

              {busy && (
                <button type="button" className="btn-secondary" onClick={() => abort.current?.abort()}>
                  暂停
                </button>
              )}

              {!busy && record?.status === "verifying" && (
                <button type="button" className="btn-primary" onClick={() => void retryFinish()}>
                  <RefreshIcon /> 完成校验
                </button>
              )}

              {!busy && (record || file) && (
                <button type="button" className="btn-secondary" onClick={() => void clear()}>
                  {record?.status === "complete" ? "上传下一个" : "清除记录"}
                </button>
              )}
            </div>
          </form>

          {stage && <p style={{ marginTop: "10px", fontSize: "15px", color: "var(--accent-primary)" }}>{stage}</p>}

          {record && (
            <div style={{ marginTop: "12px", padding: "10px", background: "var(--bg-subtle)", borderRadius: "var(--radius-sm)", fontSize: "15px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <strong>{record.filename}</strong>
                <span>{bytes(record.received)} / {bytes(record.size)}</span>
              </div>
              <progress aria-label="素材上传进度" max={record.size} value={record.received} style={{ width: "100%", height: "6px" }} />
              <div style={{ marginTop: "6px", color: "var(--text-secondary)" }}>
                {record.status === "complete" ? (
                  <span style={{ color: "var(--success-green)", display: "flex", alignItems: "center", gap: "4px" }}>
                    <CheckCircleIcon /> 已保存至素材库：{record.publishedName}
                  </span>
                ) : record.status === "verifying" ? (
                  "正在由直播电脑进行哈希校验…"
                ) : (
                  "进度已在直播电脑保存，支持断点续传。"
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="banner error" style={{ marginTop: "12px" }} role="alert">
              <AlertCircleIcon />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
