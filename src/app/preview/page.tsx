/** 独立前端验收页，只加载合成示例或浏览器选择的文件，不调用设备和发布接口。 */
"use client";
import { useState } from "react";
import { LiveNestLogo } from "../components/icons";
import MediaPreview, { MediaPreviewButton, type PreviewSample } from "../components/media-preview/media-preview";
import styles from "./preview-page.module.css";

const samples: Record<string, PreviewSample> = {
  normal: { video: "/preview/normal.mp4", music: "/preview/music.m4a", cover: "/preview/cover.svg", sound: "present" },
  noaudio: { video: "/preview/noaudio.mp4", music: "/preview/music.m4a", cover: "/preview/cover.svg", sound: "absent" },
  silent: { video: "/preview/silent.mp4", music: "/preview/music.m4a", cover: "/preview/cover.svg", sound: "silent", note: "抽样提示不代表全片检查。" },
  broken: { video: "/preview/broken.mp4", sound: "unknown" },
};
/** 编辑内容实时联动预览；测试边界只标注一次，模式或示例切换卸载旧播放器。 */
export default function PreviewPage() {
  const [mode, setMode] = useState<"live" | "video">("live"); const [sample, setSample] = useState("normal");
  const [title, setTitle] = useState("山间晨雾 · 留一段安静的时光给自己 | Morning in the mountains");
  const [channel, setChannel] = useState("山间电台 Mountain Radio"); const [original, setOriginal] = useState(false);
  const previewProps = { title, channel, mode, videoAudio: original, sample: samples[sample], videoName: sample === "normal" ? "山间晨雾.mp4" : sample === "noaudio" ? "山间晨雾_无音轨.mp4" : sample === "silent" ? "山间晨雾_静音.mp4" : "播放失败示例.mp4" };
  return <div className={styles.page}>
    <header className={styles.header}><a href="/workspace" className={styles.brand}><LiveNestLogo aria-hidden="true" /> LiveNest</a><span className={styles.local}>体验版 · 不会发布或开播</span></header>
    <main className={styles.main}>
      <div className={styles.heading}><h1>发布前预览</h1></div>
      <div className={styles.workspace}>
        <section className={styles.editor} aria-label="预览设置">
          <div className={styles.mode}><button aria-pressed={mode === "live"} onClick={() => setMode("live")}>直播配置</button><button aria-pressed={mode === "video"} onClick={() => setMode("video")}>视频发布</button></div>
          <div className={styles.sectionTitle}><h2>内容信息</h2></div>
          <label>标题<textarea rows={3} value={title} onChange={e => setTitle(e.target.value)} /></label>
          <label>频道名称<input value={channel} onChange={e => setChannel(e.target.value)} /></label>
          <div className={styles.sectionTitle}><h2>素材与声音</h2></div>
          <label>测试素材<select value={sample} onChange={e => setSample(e.target.value)}><option value="normal">有声视频 · 12 秒</option><option value="noaudio">无音轨视频 · 12 秒</option><option value="silent">静音音轨 · 12 秒</option><option value="broken">无法播放的文件</option></select></label>
          {mode === "live" && <label className={styles.audioSwitch}><div><strong>保留视频原声</strong><span>与背景音乐同时播放</span></div><input type="checkbox" checked={original} onChange={e => setOriginal(e.target.checked)} /></label>}
          <div className={styles.mobilePreview}><MediaPreviewButton key={mode + sample} {...previewProps} /></div>
        </section>
        <aside className={styles.inspector}><MediaPreview key={mode + sample} {...previewProps} /></aside>
      </div>
    </main>
  </div>;
}
