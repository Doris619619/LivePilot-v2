/** 生成前端验收的小型合成媒体，不读取客户素材；需要本地 FFmpeg，可通过 FFMPEG_PATH 指定。 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
const output = path.resolve("public/preview"); const temp = path.resolve(".data/preview-media");
await mkdir(temp, { recursive: true });
await sharp(path.join(output, "cover.svg")).png().toFile(path.join(temp, "cover.png"));
/** 直接传递参数数组；非零状态中止，防止把缺失样例当作已完成。 */
function ffmpeg(args) {
  const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("FFmpeg 示例生成失败，请检查本地 FFMPEG_PATH。");
}
ffmpeg(["-loop", "1", "-i", path.join(temp, "cover.png"), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12", "-vf", "scale=960:540", "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", "-af", "volume=0.25,afade=t=in:d=0.5,afade=t=out:st=11:d=1", "-c:a", "aac", "-movflags", "+faststart", path.join(output, "normal.mp4")]);
ffmpeg(["-i", path.join(output, "normal.mp4"), "-c:v", "copy", "-an", "-movflags", "+faststart", path.join(output, "noaudio.mp4")]);
ffmpeg(["-i", path.join(output, "noaudio.mp4"), "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "12", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", path.join(output, "silent.mp4")]);
ffmpeg(["-f", "lavfi", "-i", "aevalsrc=0.025*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t)):s=44100", "-t", "4", "-af", "afade=t=in:d=0.2,afade=t=out:st=3.8:d=0.2", "-c:a", "aac", path.join(output, "music.m4a")]);
await writeFile(path.join(output, "broken.mp4"), "LivePilot intentionally invalid browser playback fixture\n");
