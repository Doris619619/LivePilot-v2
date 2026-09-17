/** 每浏览器一个上传面板；素材归入所选实例的库，不修改当前直播选项。 */
"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { InstanceDescriptor } from "@/shared/types";
import type { UploadStatus } from "@/shared/uploads";
import { api } from "./client-request";
import { identify, transfer, uploadUrl } from "./upload-client";
const KEY = "livepilot-upload";
/** 文件容量以服务器确认的实际字节显示。 */
function bytes(value: number) { return (value / 1024 ** 2).toFixed(1) + " MiB"; }
/** 暂停后保留服务器上传记录，刷新时从本机保存的非秘密 ID 恢复。 */
export default function UploadPanel({ instances }: { instances: InstanceDescriptor[] }) {
  const [record, setRecord] = useState<UploadStatus>();
  const [instanceId, setInstanceId] = useState(instances[0]?.id || "main");
  const [kind, setKind] = useState<"videos" | "music">("videos");
  const [file, setFile] = useState<File>(); const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(""); const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  /** 存储只是续传提示，所有真实进度重新向服务器查询。 */
  function remember(next: UploadStatus) { setRecord(next); if (next.status === "complete") window.dispatchEvent(new Event("livepilot-media-updated")); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 禁用存储时本次上传仍可完成。 */ } }
  useEffect(() => {
    let active = true;
    /** 恢复记录不触发传输或覆盖用户当前选择。 */
    async function restore() {
      try {
        const saved = JSON.parse(localStorage.getItem(KEY) || "null") as UploadStatus | null;
        if (saved?.id && saved.instanceId) { const next = await api<UploadStatus>(uploadUrl(saved)); if (active) { setRecord(next); setInstanceId(next.instanceId); setKind(next.kind); } }
      } catch { if (active) setError("之前的上传记录暂时不可用。可重新连接后刷新，或选择忘记记录。"); }
    }
    void restore(); return () => { active = false; abort.current?.abort(); };
  }, []);
  useEffect(() => {
    if (record?.status !== "verifying") return;
    const current = record; let reading = false;
    /** 校验只展示服务器阶段，失败后可重复提交完成请求。 */
    async function poll() {
      if (reading) return; reading = true;
      try { const next = await api<UploadStatus>(uploadUrl(current)); remember(next); if (next.error) setError(next.error); }
      catch (e) { setError((e as Error).message); } finally { reading = false; }
    }
    const timer = setInterval(() => void poll(), 3000); return () => clearInterval(timer);
  }, [record]);
  /** 先验证完整文件身份，再从服务器偏移继续；不同文件不能拼接。 */
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!file || busy) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(""); setStage("正在校验所选文件…");
    try {
      const identity = await identify(file, controller.signal);
      let current = record;
      if (current) {
        current = await api<UploadStatus>(uploadUrl(current), { signal: controller.signal });
        if (current.size !== file.size || current.fingerprint !== identity.fingerprint) throw new Error("所选文件与原上传不同，请选择原文件，或取消原上传后重新开始。");
      } else {
        current = await api<UploadStatus>("/api/uploads", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ instanceId, kind, filename: file.name, size: file.size, fingerprint: identity.fingerprint }) });
      }
      remember(current); setStage("正在上传到直播电脑…");
      if (current.status === "uploading") await transfer(file, current, identity.hashes, controller.signal, remember);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setStage(""); }
  }
  /** 完成校验中断可重试；校验通过后不重复复制素材。 */
  async function retryFinish() {
    if (!record) return; setError("");
    try { remember(await api<UploadStatus>(uploadUrl(record, true), { method: "POST", headers: { "x-livepilot": "1" } })); } catch (e) { setError((e as Error).message); }
  }
  /** 取消只清理临时数据；已完成上传只忘记提示，媒体仍在 B。 */
  async function clear() {
    setError("");
    try {
      if (record) await api(uploadUrl(record), { method: "DELETE", headers: { "x-livepilot": "1" } });
      localStorage.removeItem(KEY); setRecord(undefined); setFile(undefined);
    } catch (e) { setError((e as Error).message); }
  }
  return <details className="upload-panel"><summary>上传这台电脑的素材</summary><p className="help">已有素材可直接在下方选择。上传的文件保存在直播电脑，传完并校验通过后即可选择；不会替换正在直播的内容。</p>
    <form onSubmit={submit} className="upload-form">
      <div className="field"><label htmlFor="upload-instance">上传到哪个实例的素材库</label><select id="upload-instance" value={instanceId} disabled={!!record || busy} onChange={e => setInstanceId(e.target.value)}>{instances.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
      <div className="field"><label htmlFor="upload-kind">素材类型</label><select id="upload-kind" value={kind} disabled={!!record || busy} onChange={e => setKind(e.target.value as "videos" | "music")}><option value="videos">视频</option><option value="music">音乐</option></select></div>
      <div className="field upload-file"><label htmlFor="upload-file">{record?.status === "complete" ? "已上传文件" : record ? "继续上传时重新选择原文件" : "选择本电脑文件"}</label><input id="upload-file" type="file" disabled={busy || (!!record && record.status !== "uploading")} accept={kind === "videos" ? ".mp4,.mkv,.mov,.webm,.avi,.m4v" : ".mp3,.wav,.flac,.aac,.m4a,.ogg"} onChange={e => setFile(e.target.files?.[0])} /></div>
      <div className="upload-actions">
        {(!record || record.status === "uploading") && <button className="primary" disabled={!file || busy}>{busy ? "处理中…" : record ? "继续上传" : "上传到直播电脑"}</button>}
        {busy && <button type="button" onClick={() => abort.current?.abort()}>暂停</button>}
        {!busy && record?.status === "verifying" && <button type="button" onClick={() => void retryFinish()}>重试完成校验</button>}
        {!busy && <button type="button" onClick={() => void clear()}>{record?.status === "complete" ? "上传另一个文件" : record ? "取消此上传" : "忘记上次记录"}</button>}
      </div>
    </form>
    {stage && <p role="status">{stage}</p>}
    {record && <div className="upload-progress"><p>{record.filename} · {bytes(record.received)} / {bytes(record.size)}</p><progress max={record.size} value={record.received} aria-label="直播电脑已确认接收的字节" /><p role="status">{record.status === "complete" ? "已加入素材库：" + record.publishedName : record.status === "verifying" ? "正在直播电脑校验文件。关闭页面后仍会继续。" : "进度已保存在直播电脑；暂停后可继续。"}</p></div>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </details>;
}
