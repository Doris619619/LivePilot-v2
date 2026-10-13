/** 独立前端验收页，只加载合成示例或浏览器选择的文件，不调用设备和发布接口。 */
"use client";
import { useState } from "react";
import MediaPreview, { MediaPreviewButton, type PreviewSample } from "../components/media-preview/media-preview";
import styles from "./preview-page.module.css";

const samples: Record<string, PreviewSample> = {
  normal: { video: "/preview/normal.mp4", music: "/preview/music.m4a", cover: "/preview/cover.svg", sound: "present" },
  noaudio: { video: "/preview/noaudio.mp4", music: "/preview/music.m4a", cover: "/preview/cover.svg", sound: "absent" },
  silent: { video: "/preview/silent.mp4", music: "/preview/music.m4a", cover: "/preview/cover.svg", sound: "silent", note: "示例音轨为静音。抽样提示不代表已完成全片检查。" },
  broken: { video: "/preview/broken.mp4", sound: "unknown", note: "这是用于测试播放失败提示的无效文件。" },
};
/** 编辑内容实时联动预览，模式或示例切换卸载旧播放器；移动端使用全屏弹层。 */
export default function PreviewPage() {
  const [mode, setMode] = useState<"live" | "video">("live"); const [sample, setSample] = useState("normal");
  const [title, setTitle] = useState("山间晨雾 · 留一段安静的时光给自己 | Morning in the mountains");
  const [channel, setChannel] = useState("山间电台 Mountain Radio"); const [original, setOriginal] = useState(false);
  const previewProps = { title, channel, mode, videoAudio: original, sample: samples[sample], videoName: sample === "normal" ? "山间晨雾.mp4" : sample === "noaudio" ? "山间晨雾_无音轨.mp4" : sample === "silent" ? "山间晨雾_静音.mp4" : "播放失败示例.mp4" };
  return <div className={styles.page}>
    <header className={styles.header}><a href="/workspace" className={styles.brand}><span>▸</span> LivePilot</a><span>发布前预览 <i /> 前端体验版</span><span className={styles.local}>本地测试</span></header>
    <main className={styles.main}>
      <div className={styles.heading}><div><p>内容工作台 / 发布前检查</p><h1>发布前预览</h1><span>试听声音，核对时长，看看观众会看到什么。</span></div><span className={styles.demoNote}>示例数据 · 不会发布或开播</span></div>
      <div className={styles.workspace}>
        <section className={styles.editor} aria-label="预览设置">
          <div className={styles.mode}><button aria-pressed={mode === "live"} onClick={() => setMode("live")}>直播配置</button><button aria-pressed={mode === "video"} onClick={() => setMode("video")}>视频发布</button></div>
          <div className={styles.sectionTitle}><span>01</span><h2>内容信息</h2></div>
          <label>标题<textarea rows={3} value={title} onChange={e => setTitle(e.target.value)} /></label><p className={styles.fieldHint}>修改后，右侧的封面／标题预览会同步更新。</p>
          <label>频道名称<input value={channel} onChange={e => setChannel(e.target.value)} /></label>
          <div className={styles.sectionTitle}><span>02</span><h2>素材与声音</h2></div>
          <label>测试素材<select value={sample} onChange={e => setSample(e.target.value)}><option value="normal">有声视频 · 12 秒</option><option value="noaudio">无音轨视频 · 12 秒</option><option value="silent">静音音轨 · 12 秒</option><option value="broken">无法播放的文件</option></select></label>
          <p className={styles.fieldHint}>也可以在预览中选择自己的本地视频。</p>
          {mode === "live" ? <label className={styles.audioSwitch}><div><strong>保留视频原声</strong><span>发布效果中，与背景音乐一起播放</span></div><input type="checkbox" checked={original} onChange={e => setOriginal(e.target.checked)} /></label> : <p className={styles.audioRule}>有背景音乐时替换原声，短音乐循环、长音乐截断，成片时长跟随视频。</p>}
          <div className={styles.boundary}><strong>先看、先听，不需要确认发布</strong><p>当前可以真实播放本地文件。示例声音提示用于查看界面，完整检查和最终成片将在前端确认后接入。</p></div>
          <div className={styles.mobilePreview}><MediaPreviewButton key={mode + sample} {...previewProps} /></div>
        </section>
        <aside className={styles.inspector}><MediaPreview key={mode + sample} {...previewProps} /></aside>
      </div>
    </main>
  </div>;
}
