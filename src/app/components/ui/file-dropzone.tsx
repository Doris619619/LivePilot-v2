/** 单文件拖拽入口，沿用 21st Image Preview Dropzone 的 react-dropzone 交互，上传仍由调用方执行。 */
"use client";
import { useState } from "react";
import { useDropzone, type Accept } from "react-dropzone";
import { UploadIcon, CheckCircleIcon } from "../icons";
/** 拖入、点击和键盘选择共用相同校验；禁止多文件静默覆盖，失败保留原选择。 */
export default function FileDropzone({ id, label, hint, name, accept, maxSize, disabled, onFile }: { id: string; label: string; hint: string; name?: string; accept: Accept; maxSize?: number; disabled?: boolean; onFile: (file: File) => void }) {
  const [error, setError] = useState("");
  const { getRootProps, getInputProps, open, isDragActive } = useDropzone({ accept, maxSize, multiple: false, disabled, noClick: true, noKeyboard: true,
    onDropAccepted: files => { setError(""); if (files[0]) onFile(files[0]); },
    onDropRejected: () => setError("文件未选择，请选择一个符合格式与大小要求的文件。"),
  });
  return <div {...getRootProps({ className: "ui-dropzone", "data-dragging": isDragActive, "data-disabled": !!disabled })}>
    <input {...getInputProps({ id, "aria-hidden": true, tabIndex: -1 })} />
    <div className="ui-dropzone-icon">{name ? <CheckCircleIcon /> : <UploadIcon />}</div>
    <strong>{isDragActive ? "松开以选择文件" : name || "拖拽文件到这里"}</strong>
    <span id={id + "-hint"}>{hint}</span><button type="button" disabled={disabled} onClick={open}>{label}</button>
    {error && <p role="alert" className="broadcast-error">{error}</p>}
  </div>;
}
