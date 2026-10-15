/** 展示 Agent 检查事实与覆盖范围，区分工具缺失、采样和完整检查；提供可取消的主动检查。 */
import type { PreviewFile } from "@/shared/media-preview";
import type { RemotePreview } from "./device-preview";
import { mediaTime } from "./local-media";
import styles from "./preview.module.css";
/** 检查结果不代替听感确认；有音轨、疑似静音与解码成功分别说明。 */
function FileCheck({ label, file }: { label: string; file: PreviewFile }) {
  const check = file.check;
  const sound = file.audio === false ? "没有音轨" : check?.sound === "suspected-silent" ? "检测范围内疑似静音，请试听确认" : file.audio ? "含音轨" : "音轨尚未检测";
  return <div className={styles.fileCheck}><strong>{label} · {sound}</strong>
    {file.video === false && label !== "音乐" && <p className={styles.warning}>未找到视频轨</p>}
    {check?.state === "complete" && <details className={styles.coverage}><summary>{check.coverage === "full" ? "完整检查完成" : "抽样检查完成"}</summary><p className={styles.hint}>{check.coverage === "full" ? "已完成第一路视频及音频的全程解码检查" : "已抽样检查画面与声音"}{check.ranges?.length ? "：" + check.ranges.map(r => `${mediaTime(r.start)}–${mediaTime(r.start + r.duration)}`).join("、") : ""}{check.coverage === "sample" && "；未检查其余部分"}</p></details>}
    {check?.state === "running" && <p role="status">{check.coverage === "full" ? "完整检查" : "快速检查"} {check.progress ?? 0}%</p>}
    {check && ["failed", "unavailable", "cancelled"].includes(check.state) && <p className={styles.warning}>{check.message}</p>}
  </div>;
}
/** 仅发布包可提前生成最终文件；只在已有结果后展示播放入口。 */
export default function DeviceChecks({ remote, mode, playFinal }: { remote: RemotePreview; mode: "live" | "video"; playFinal(): void }) {
  return <div className={styles.checks}><h4>声音与文件</h4>
    {remote.files.video && <FileCheck label="视频" file={remote.files.video} />}
    {remote.files.music && <FileCheck label="音乐" file={remote.files.music} />}
    {remote.files.final && <FileCheck label="最终成片" file={remote.files.final} />}
    {remote.error && !Object.values(remote.files).some(f => f?.check?.message === remote.error) && <p className={styles.warning} role="alert">{remote.error}</p>}
    {remote.busy && remote.operation === "prepare" && <p role="status">正在准备最终成片…</p>}
    <div className={styles.checkActions}><button type="button" disabled={remote.busy} onClick={() => remote.action("check")}>完整检查</button>{mode === "video" && <button type="button" disabled={remote.busy} onClick={() => remote.action("prepare")}>检查最终成片</button>}{remote.busy && <button type="button" onClick={() => remote.action("cancel")}>取消检查</button>}{remote.files.final && !remote.busy && <button type="button" onClick={playFinal}>播放最终成片</button>}</div>
  </div>;
}
