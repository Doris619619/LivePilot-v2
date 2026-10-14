/** Agent 本机媒体检查：受限 ffprobe 与逐段/全程解码，原始输出和文件路径不返回浏览器。 */
import { spawn } from "node:child_process";
import { AppError } from "../errors";
import { toolsFor } from "../publishing/render";
import type { PreviewCheck, PreviewFile } from "@/shared/media-preview";
type Tools = Awaited<ReturnType<typeof toolsFor>>;
/** 子进程仅使用参数数组，限制内存并响应取消；进度与静音事件逐行消费。 */
function run(executable: string, args: string[], signal: AbortSignal, line?: (value: string) => void): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errorTail = ""; let pending = ""; let oversized = false;
    const abort = () => child.kill(); signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", data => { if (line) { pending += data.toString(); const lines = pending.split(/[\r\n]+/); pending = lines.pop() || ""; for (const value of lines) line(value); if (pending.length > 8192) pending = ""; } else { output += data.toString(); if (output.length > 128 * 1024) { oversized = true; child.kill(); } } });
    child.stderr.on("data", data => { errorTail = (errorTail + data.toString()).slice(-8192); line?.(data.toString()); });
    child.once("error", () => { signal.removeEventListener("abort", abort); reject(new AppError("FFMPEG_MISSING", "媒体检查工具不可用，请在设备安装 FFmpeg 与 ffprobe。")); });
    child.once("close", code => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(signal.reason); else if (code || oversized || /Error while decoding|corrupt decoded frame|Invalid data found/i.test(errorTail)) reject(new AppError("MEDIA_DECODE", "媒体探测或解码失败，请检查文件完整性和编码格式。")); else resolve(output); });
    if (signal.aborted) abort();
  });
}
/** 快速探测只读取流元信息；没有 FFmpeg 不等于素材损坏。 */
export async function inspectMetadata(file: string, target: PreviewFile, tools: Tools, signal: AbortSignal) {
  const output = await run(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=duration", "-of", "json", file], AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
  let parsed: { streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number } }[]; format?: { duration?: string } };
  try { parsed = JSON.parse(output); } catch { throw new AppError("MEDIA_PROBE", "无法读取媒体元信息。"); }
  const video = parsed.streams?.find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = parsed.streams?.some(s => s.codec_type === "audio") || false;
  const duration = [video?.duration, parsed.format?.duration].map(Number).find(value => Number.isFinite(value) && value > 0);
  Object.assign(target, { video: !!video, audio, ...(video ? { width: video.width, height: video.height, codec: video.codec_name } : {}), ...(duration !== undefined ? { duration } : {}) });
}
/** 开头、中间、末尾各最多三秒；相邻区间合并，报告实际检查覆盖范围。 */
export function sampleRanges(duration: number) {
  const length = Math.min(3, duration); const starts = [0, Math.max(0, (duration - length) / 2), Math.max(0, duration - length)];
  const ranges: { start: number; duration: number }[] = [];
  for (const start of starts) { const last = ranges.at(-1); if (last && start <= last.start + last.duration) last.duration = Math.max(last.duration, start + length - last.start); else ranges.push({ start, duration: length }); }
  return ranges;
}
/** 全程只解码第一路视频/音频并检测静音；进度以媒体时间估算，取消不返回成功。 */
export async function decodeCheck(file: string, info: PreviewFile, tools: Tools, full: boolean, signal: AbortSignal, update: (check: PreviewCheck) => void) {
  if (!info.duration) throw new AppError("MEDIA_DURATION", "无法确认时长，尚未执行解码检查。");
  const ranges = full ? [{ start: 0, duration: info.duration }] : sampleRanges(info.duration);
  const total = ranges.reduce((sum, range) => sum + range.duration, 0); let checked = 0; let silent = 0;
  const result: PreviewCheck = { state: "running", coverage: full ? "full" : "sample", progress: 0, sound: info.audio ? "unknown" : "absent", ranges: [] }; update({ ...result });
  for (const range of ranges) {
    let silenceStart: number | undefined; let tail = "";
    await run(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "info", "-xerror", "-err_detect", "explode", "-threads", "1", ...(!full ? ["-ss", String(range.start)] : []), "-i", file, ...(!full ? ["-t", String(range.duration)] : []), "-map", "0:v:0?", "-map", "0:a:0?", ...(info.audio ? ["-af", "silencedetect=noise=-50dB:d=0.3"] : []), "-threads", "1", "-progress", "pipe:1", "-f", "null", "-"], signal, value => {
      const time = /out_time_us=(\d+)/.exec(value); if (time) { result.progress = Math.min(99, Math.floor((checked + Math.min(range.duration, Number(time[1]) / 1e6)) / total * 100)); update({ ...result }); }
      tail = (tail + value).slice(-8192); const lines = tail.split(/\r?\n/); tail = lines.pop() || "";
      for (const text of lines) { const start = /silence_start: ([\d.]+)/.exec(text); if (start) silenceStart = Number(start[1]); const end = /silence_end: ([\d.]+)/.exec(text); if (end && silenceStart !== undefined) { silent += Math.max(0, Math.min(range.duration, Number(end[1])) - silenceStart); silenceStart = undefined; } }
    });
    if (silenceStart !== undefined) silent += Math.max(0, range.duration - silenceStart);
    checked += range.duration; result.ranges!.push(range);
  }
  signal.throwIfAborted(); update({ ...result, state: "complete", progress: 100, sound: !info.audio ? "absent" : silent >= total * .9 ? "suspected-silent" : "present" });
}
