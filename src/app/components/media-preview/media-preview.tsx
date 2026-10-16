/** 共享预览面板：正式入口读取已绑定设备素材，独立体验页保持本地播放和明确的检测示例。 */
"use client";
import { useId, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger, SurfaceDialog } from "../ui/primitives";
import { VideoIcon, YouTubeIcon } from "../icons";
import MediaPlayer from "./media-player";
import YouTubeFeed from "./youtube-feed";
import { useLocalMedia, mediaTime } from "./local-media";
import styles from "./preview.module.css";
import type { PreviewSelection } from "@/shared/media-preview";
import DevicePreview, { type RemotePreview } from "./device-preview";
import DeviceChecks from "./device-checks";
import YouTubeReceiver from "./youtube-receiver";
import { useWorkbenchActive } from "../workbench-context";

export type PreviewSample = { video: string; music?: string; cover?: string; sound: "present" | "absent" | "silent" | "unknown"; note?: string };
export type MediaPreviewProps = { title: string; channel?: string; mode?: "live" | "video"; videoName?: string; musicName?: string; videoAudio?: boolean; cover?: string; coverName?: string; live?: boolean; scheduledAt?: string; sample?: PreviewSample; selection?: PreviewSelection; remote?: RemotePreview; receiver?: { id?: string; privacy?: string } };

/** 正式入口读取已配置素材；无设备选择的独立测试页仍使用浏览器本地文件。 */
export default function MediaPreview({ selection, ...props }: MediaPreviewProps) {
  const active = useWorkbenchActive();
  return selection ? active ? <DevicePreview key={JSON.stringify(selection)} {...props} selection={selection} /> : null : <MediaPreviewPanel {...props} />;
}

/** 文件选择只创建浏览器 URL；检查结果就地展示，能力边界折叠；关闭弹层卸载播放器。 */
export function MediaPreviewPanel({ title, channel, mode = "video", videoName, musicName, videoAudio = false, cover, coverName, live, scheduledAt, sample, remote, receiver }: MediaPreviewProps) {
  const active = useWorkbenchActive();
  const [final, setFinal] = useState(false);
  const id = useId(); const [tab, setTab] = useState("content"); const [effect, setEffect] = useState(false); const [device, setDevice] = useState("mobile");
  const [localVideo, setVideoFile] = useLocalMedia(); const [localMusic, setMusicFile] = useLocalMedia(); const [localCover, setCoverFile] = useLocalMedia();
  const videoFile = localVideo?.file; const musicFile = localMusic?.file;
  const [info, setInfo] = useState<{ duration: number; width: number; height: number; source: string }>(); const [musicInfo, setMusicInfo] = useState<{ duration: number; source: string }>();
  const video = remote ? remote.url(final ? "final" : "video") : localVideo?.url || sample?.video; const music = remote ? final ? undefined : remote.url("music") : localMusic?.url || sample?.music; const poster = cover || (remote ? remote.url("cover") : localCover?.url || sample?.cover);
  const current = (info?.source === video ? info : undefined) || remote?.files[final ? "final" : "video"]; const musicDuration = remote?.files.music?.duration ?? (musicInfo?.source === music ? musicInfo?.duration : undefined);
  const sound = videoFile ? "unknown" : sample?.sound || "unknown";
  const fileLabel = remote?.files[final ? "final" : "video"]?.name || videoFile?.name || videoName || (sample ? "山间晨雾.mp4" : "尚未选择本地视频");
  return <section className={styles.preview} aria-label="发布前预览">
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList aria-label="预览类型"><TabsTrigger value="content">预览内容</TabsTrigger><TabsTrigger value="cover">预览封面／标题</TabsTrigger></TabsList>
      <TabsContent value="content">
        {active && tab === "content" && <>
          <div className={styles.previewHeading}><span>本机预览</span></div>
          <div className={styles.segment} aria-label="试听来源"><button type="button" aria-pressed={!effect && !final} onClick={() => { setFinal(false); setEffect(false); }}>原视频</button><button type="button" aria-pressed={effect && !final} onClick={() => { setFinal(false); setEffect(true); }}>发布效果</button>{final && <span>最终成片</span>}</div>
          {video ? <MediaPlayer key={[video, music, effect, videoAudio].join(":")} video={video} music={music} effect={effect && !final} sourceLabel={final ? "最终成片" : undefined} originalAudio={mode === "live" ? videoAudio : !music} loop={mode === "live"} poster={poster} metadata={(duration, width, height) => setInfo({ duration, width, height, source: video })} musicMetadata={duration => setMusicInfo({ duration, source: music || "" })} /> : <div className={styles.empty}><VideoIcon width={32} height={32} /><strong>选择视频以预览</strong><p>{videoName ? "当前素材不可预览，可选择本地文件试听。" : "选择当前电脑上的文件即可预览，不会上传。"}</p></div>}
          <div className={styles.fileLine}><VideoIcon /><span title={fileLabel}>{fileLabel}</span>{!remote && <label htmlFor={id + "-video"} className={styles.fileButton}>选择本地视频<input id={id + "-video"} type="file" accept="video/*,.mkv,.avi" onChange={event => setVideoFile(event.target.files?.[0])} /></label>}</div>
          <div className={styles.facts}><div><span>视频时长{mode === "live" && " · 循环播放"}</span><strong>{mediaTime(current?.duration)}</strong></div><div><span>画面尺寸</span><strong>{current?.width && current.height ? `${current.width} × ${current.height}` : "待读取"}</strong></div>{mode === "video" && effect && <div><span>预计成片</span><strong>{mediaTime(current?.duration)}</strong></div>}</div>
          {effect && !final && <div className={styles.music}><div><span>背景音乐</span><strong>{remote?.files.music?.name || musicFile?.name || musicName || (sample?.music ? "轻音乐示例.m4a" : "未选择")}</strong><small>{mediaTime(musicDuration)}{music && " · 短音乐循环播放"}</small></div>{!remote && <label htmlFor={id + "-music"} className={styles.fileButton}>选择音乐<input id={id + "-music"} type="file" accept="audio/*" onChange={event => setMusicFile(event.target.files?.[0])} /></label>}</div>}
          {remote ? <DeviceChecks remote={remote} mode={mode} playFinal={() => setFinal(true)} /> : <div className={styles.checks}>
            <div><h4>声音与文件</h4>{sample && !videoFile && <span>示例检测结果</span>}</div>
            <p className={sound === "absent" || sound === "silent" ? styles.warning : styles.result}><span className={styles.statusDot} />{sound === "absent" ? "原视频没有音轨" : sound === "silent" ? "采样片段疑似静音，建议试听核对" : sound === "present" ? "含音轨，可播放试听" : "音轨尚未检测，请播放确认声音"}</p>
            {sample?.note && !videoFile && <p className={styles.warning}>{sample.note}</p>}
            {effect && <p className={styles.hint}>{music ? mode === "live" ? videoAudio ? "视频与音乐分别循环，保留视频原声。" : "视频与音乐分别循环，关闭视频原声。" : "背景音乐替换视频原声，时长跟随视频。" : mode === "live" && !videoAudio ? "视频原声已关闭，未选择背景音乐。" : musicName ? "设备音乐尚未读取，请选择本地音乐；当前仅播放视频原声。" : "尚未选择音乐，当前播放视频原声。"}</p>}
          </div>}
          {mode === "live" && receiver && <YouTubeReceiver {...receiver} />}
          <details className={styles.previewHelp}><summary>预览说明</summary><p>{remote ? "预览和检查不会上传或开播。发布效果为本机试听，最终成片复用正式发布文件。" : "本地文件仅在浏览器播放，不会上传。完整检查和最终成片检查暂不可用。"}</p>{mode === "live" && <p>本机试听不代表 OBS 或 YouTube 实际输出。</p>}</details>
        </>}
      </TabsContent>
      <TabsContent value="cover">
        <div className={styles.previewHeading}><span>展示效果示意</span><YouTubeIcon /></div>
        <div className={styles.segment} aria-label="展示设备"><button type="button" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")}>手机端</button><button type="button" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}>桌面端</button></div>
        <YouTubeFeed title={title} channel={channel} poster={poster} coverName={coverName} live={live} scheduledAt={scheduledAt} duration={mode === "video" ? current?.duration : undefined} device={device} />
        <p className={styles.hint}>封面与标题示意，实际展示以 YouTube 为准。</p>
        {!remote && <label htmlFor={id + "-cover"} className={styles.coverPicker}>选择本地封面<input id={id + "-cover"} type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setCoverFile(event.target.files?.[0])} /></label>}
        <details className={styles.fullTitle}><summary>查看完整标题</summary><p>{title || "尚未填写标题"}</p></details>
      </TabsContent>
    </Tabs>
  </section>;
}

/** 发布列表复用同一预览；关闭即卸载本地媒体，移动端采用全屏面板。 */
export function MediaPreviewButton(props: MediaPreviewProps) {
  const [open, setOpen] = useState(false);
  return <SurfaceDialog open={open} onOpenChange={setOpen} title="发布前预览" description={props.videoName || props.title} side="right" trigger={<button type="button" className="btn-ghost">预览</button>}>{open && <div className={styles.dialogContent}><MediaPreview {...props} /></div>}</SurfaceDialog>;
}

/** 编辑弹层默认展示预览但不自动播放；收起时卸载播放器，避免隐藏后继续发声。 */
export function InlineMediaPreview(props: MediaPreviewProps) {
  const [open, setOpen] = useState(true); const id = useId();
  return <div className={styles.inlineToggle}><button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? "收起预览" : "预览内容与封面"}</button><div id={id}>{open && <MediaPreview {...props} />}</div></div>;
}
