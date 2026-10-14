/** 本地试播播放器：视频与音乐使用同一播放时钟，支持原声、混合试听、拖动和离开停止。 */
"use client";
import { useEffect, useRef, useState } from "react";
import { PlayIcon } from "../icons";
import { mediaTime } from "./local-media";
import styles from "./preview.module.css";

type Props = { video: string; music?: string; effect: boolean; originalAudio: boolean; loop: boolean; poster?: string; sourceLabel?: string; metadata(duration: number, width: number, height: number): void; musicMetadata(duration: number): void };
/** 每组素材独立挂载；合成试听不是成片，缓冲或音乐失败时一起暂停，避免误听为无声。 */
export default function MediaPlayer({ video, music, effect, originalAudio, loop, poster, sourceLabel, metadata, musicMetadata }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null); const musicRef = useRef<HTMLAudioElement>(null); const frame = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false); const [position, setPosition] = useState(0); const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.65); const [muted, setMuted] = useState(false); const [error, setError] = useState("");
  const request = useRef({ generation: 0, disposed: false });
  /** 浏览器错误与设备探测结果分开，网络中断不能当成文件损坏。 */
  function mediaFailure(media: HTMLMediaElement, label: string) {
    pause();
    const code = media.error?.code;
    setError(code === 2 ? `${label}读取中断，请检查网络和设备连接后重新打开预览。` : code === 3 ? `${label}解码失败，请重试并查看设备检查结果，或更换编码格式。` : code === 4 ? `${label}无法在浏览器中播放，可尝试 MP4（H.264）或兼容的音频编码；尚未判定文件损坏。` : `${label}播放已中断，请重新打开预览后重试。`);
  }
  /** 暂停会失效尚未完成的 play promise，防止快速切换后背景继续发声。 */
  function pause() { request.current.generation++; videoRef.current?.pause(); musicRef.current?.pause(); setPlaying(false); }
  /** 用视频时间定位独立循环的音乐；短音乐从头续播，长音乐随视频结束停止。 */
  function align() {
    const v = videoRef.current; const a = musicRef.current;
    if (!v || !a || !effect || !Number.isFinite(a.duration) || !a.duration) return;
    const target = v.currentTime % a.duration;
    if (Math.abs(a.currentTime - target) > 0.3) a.currentTime = target;
  }
  /** 只有用户按下播放才启动声音；任何一轨失败均停止并显示就地提示。 */
  async function play() {
    const v = videoRef.current; if (!v) return;
    const current = ++request.current.generation; setError(""); if (!loop) align(); setPlaying(true);
    try {
      await Promise.all([v.play(), effect && music ? musicRef.current?.play() : undefined]);
      if (current !== request.current.generation || request.current.disposed) return;
    } catch { if (current === request.current.generation && !request.current.disposed) { pause(); setError("无法播放，请重试或更换文件。浏览器格式不支持不等于文件损坏。"); } }
  }
  useEffect(() => {
    const v = videoRef.current; const a = musicRef.current;
    if (v) { v.volume = volume; v.muted = muted || effect && !originalAudio; }
    if (a) { a.volume = volume; a.muted = muted; }
  }, [volume, muted, effect, music, originalAudio]);
  useEffect(() => {
    const v = videoRef.current; const a = musicRef.current; const lifecycle = request.current;
    lifecycle.disposed = false;
    if (v) v.src = video;
    if (a && music) a.src = music;
    return () => { lifecycle.generation++; lifecycle.disposed = true; v?.pause(); a?.pause(); v?.removeAttribute("src"); a?.removeAttribute("src"); v?.load(); a?.load(); };
  }, [video, music]);
  useEffect(() => {
    /** 切到后台自动暂停，避免用户关闭预览却继续听到声音。 */
    const stopHidden = () => { if (document.hidden) { request.current.generation++; videoRef.current?.pause(); musicRef.current?.pause(); setPlaying(false); } };
    document.addEventListener("visibilitychange", stopHidden); return () => document.removeEventListener("visibilitychange", stopHidden);
  }, []);
  useEffect(() => {
    /** 响应式布局将面板隐藏时停止媒体；不在用户调整窗口后留下后台声音。 */
    const stopInvisible = () => { if (frame.current && !frame.current.getClientRects().length) { request.current.generation++; videoRef.current?.pause(); musicRef.current?.pause(); setPlaying(false); } };
    window.addEventListener("resize", stopInvisible); return () => window.removeEventListener("resize", stopInvisible);
  }, []);
  return <>
    <div ref={frame} className={styles.player}>
      <video ref={videoRef} src={video} poster={poster} playsInline preload="metadata" loop={loop} aria-label="素材预览视频"
        onLoadedMetadata={event => { const v = event.currentTarget; setDuration(v.duration); metadata(v.duration, v.videoWidth, v.videoHeight); }}
        onTimeUpdate={event => { setPosition(event.currentTarget.currentTime); if (!loop) align(); }} onSeeked={() => { align(); }}
        onWaiting={() => musicRef.current?.pause()} onPlaying={() => { if (effect && music && !request.current.disposed && !videoRef.current?.paused) { if (!loop) align(); const current = request.current.generation; void musicRef.current?.play().catch(() => { if (!request.current.disposed && current === request.current.generation) { pause(); setError("背景音乐无法播放，请检查所选文件。"); } }); } }}
        onEnded={pause} onError={event => mediaFailure(event.currentTarget, "视频")} />
      {music && <audio ref={musicRef} src={music} loop preload="metadata" onLoadedMetadata={event => musicMetadata(event.currentTarget.duration)} onError={event => { if (effect) mediaFailure(event.currentTarget, "背景音乐"); }} />}
      <button type="button" className={styles.pictureToggle} aria-label={playing ? "点击画面暂停" : "点击画面播放"} onClick={() => playing ? pause() : void play()}>{!playing && <span className={styles.playMark}><PlayIcon width={26} height={26} /></span>}</button>
      <span className={styles.sourceLabel}>{sourceLabel || (effect ? "发布效果试听" : "原视频")}</span>
      <div className={styles.playerControls}>
        <input aria-label="播放进度" type="range" min={0} max={Number.isFinite(duration) ? duration : 0} step={0.1} value={position} disabled={!duration} onChange={event => { const time = Number(event.target.value); if (videoRef.current) videoRef.current.currentTime = time; setPosition(time); align(); }} />
        <div><button type="button" aria-label={playing ? "暂停预览" : "播放预览"} onClick={() => playing ? pause() : void play()}>{playing ? "暂停" : "播放"}</button><span>{mediaTime(position)} / {mediaTime(duration || undefined)}</span><button type="button" aria-label={muted ? "开启声音" : "静音"} onClick={() => setMuted(!muted)}>{muted ? "已静音" : "声音"}</button><input aria-label="预览音量" type="range" min={0} max={1} step={0.05} value={volume} onChange={event => setVolume(Number(event.target.value))} /><button type="button" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void frame.current?.requestFullscreen().catch(() => setError("当前浏览器无法进入全屏。")); }}>全屏</button></div>
      </div>
    </div>
    {(muted || volume === 0) && <p className={styles.hint}>播放器已静音，不能据此判断素材没有声音。</p>}
    {!muted && volume > 0 && effect && !originalAudio && !music && <p className={styles.hint}>已按配置关闭视频原声，当前没有背景音乐。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </>;
}
