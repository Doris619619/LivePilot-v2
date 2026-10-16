/** 依据用户提供的首页参考图展示 YouTube 信息流；周围内容仅作占位，不制造平台数据。 */
"use client";
import { useEffect, useRef, useState } from "react";
import { SurfaceDialog } from "../ui/primitives";
import { YouTubeIcon, VideoIcon, UserIcon } from "../icons";
import { mediaTime } from "./local-media";
import styles from "./youtube-feed.module.css";

type Props = { title: string; channel?: string; poster?: string; coverName?: string; live?: boolean; scheduledAt?: string; duration?: number; device: string };

/** 背景框架的线性图标固定尺寸，不依赖系统字体绘制导航符号。 */
function FeedIcon({ kind }: { kind: "menu" | "search" | "home" | "shorts" | "subscriptions" | "plus" }) {
  const paths = { menu: "M4 6h16M4 12h16M4 18h16", search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0", home: "m3 10 9-7 9 7v11h-6v-7H9v7H3Z", shorts: "m15 3-8 5a4 4 0 0 0 1 7l-1 1a3 3 0 0 0 3 5l8-5a4 4 0 0 0-1-7l1-1a3 3 0 0 0-3-5ZM10 9l5 3-5 3Z", subscriptions: "M7 3h10M4 6h16M3 9h18v12H3ZM10 12l5 3-5 3Z", plus: "M12 4v16M4 12h16" };
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

/** 搜索、菜单和分类仅作为示意背景，不呈现为可以操作的按钮。 */
function FeedHeader() {
  return <><div className={styles.header} aria-hidden="true"><span className={styles.menu}><FeedIcon kind="menu" /></span><span className={styles.brand}><YouTubeIcon />YouTube</span><div className={styles.search}>搜索<span><FeedIcon kind="search" /></span></div><span className={styles.user}><UserIcon /></span></div><div className={styles.filters} aria-hidden="true"><span>全部</span><span>音乐</span><span>直播</span><span>Lo-fi</span><span>最近上传</span></div></>;
}

/** 中性占位体现相邻视频的位置；不虚构标题、频道、观看人数或播放量。 */
function PlaceholderCard() {
  return <div className={styles.placeholder} aria-hidden="true"><div className={styles.placeholderCover}><VideoIcon /><span>其他视频占位</span></div><div className={styles.placeholderInfo}><i /><div><b /><b /><b /></div></div></div>;
}

/** 封面和文案保留真实输入；两行标题与省略菜单对应首页卡片，而非播放器外框。 */
function FeedCard({ title, channel, poster, coverName, live, scheduledAt, duration }: Props) {
  const label = live ? "直播中" : scheduledAt ? "即将开始" : duration !== undefined && Number.isFinite(duration) ? mediaTime(duration) : "";
  return <article className={styles.card} aria-label="当前视频展示卡片">
    <div className={styles.cover}>{poster ? <img /* eslint-disable-line @next/next/no-img-element -- 浏览器本地 Blob 或已选封面，仅作展示。 */ src={poster} alt="当前封面展示示意" /> : <div className={styles.empty}><YouTubeIcon /><span>{coverName ? "已选择封面" : "YouTube 自动选择"}</span><small>{coverName ? "设备图片读取待接入" : "实际封面待定"}</small></div>}{label && <span className={live ? styles.live : styles.duration}>{label}</span>}</div>
    <div className={styles.info}><span className={styles.avatar} aria-hidden="true">{(channel || "L").slice(0, 1)}</span><div><h4 title={title}>{title.trim() || "你的标题将显示在这里"}</h4><p>{channel || "当前频道"}</p>{scheduledAt && <small>预约 · {scheduledAt}</small>}</div><span className={styles.more} aria-hidden="true">⋮</span></div>
  </article>;
}

/** 手机使用单列信息流；桌面三列场景只在展开后显示，并整体适应可用宽度。 */
function FeedScene(props: Props) {
  const desktop = props.device === "desktop";
  return <FitScene desktop={desktop}>
    <div className={desktop ? styles.desktop : styles.mobile}>
      <FeedHeader />
      <div className={styles.body}>
        {desktop && <div className={styles.sidebar} aria-hidden="true"><span><FeedIcon kind="home" /><small>首页</small></span><span><FeedIcon kind="shorts" /><small>Shorts</small></span><span><FeedIcon kind="subscriptions" /><small>订阅</small></span><span><UserIcon /><small>你</small></span></div>}
        <div className={styles.grid}><FeedCard {...props} /><PlaceholderCard />{desktop && <><PlaceholderCard /><PlaceholderCard /><PlaceholderCard /><PlaceholderCard /></>}</div>
      </div>
      {!desktop && <div className={styles.bottom} aria-hidden="true"><span><FeedIcon kind="home" /><small>首页</small></span><span><FeedIcon kind="shorts" /><small>Shorts</small></span><span><FeedIcon kind="plus" /><small>创建</small></span><span><FeedIcon kind="subscriptions" /><small>订阅</small></span><span><UserIcon /><small>你</small></span></div>}
    </div>
  </FitScene>;
}

/** 固定桌面画布整体缩放，而非裁切封面；同时回收缩放后的布局高度，避免留下长空白。 */
function FitScene({ desktop, children }: { desktop: boolean; children: React.ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ scale: 1, height: 0 });
  useEffect(() => {
    if (!desktop || !viewport.current || !canvas.current) return;
    const frame = viewport.current; const content = canvas.current;
    /** 同时观察容器宽度和内容高度，长标题与窗口缩放都能重新适配。 */
    const measure = () => { const scale = Math.min(1, frame.clientWidth / 1050); setSize({ scale, height: content.scrollHeight * scale }); };
    const observer = new ResizeObserver(measure); observer.observe(frame); observer.observe(content); measure();
    return () => observer.disconnect();
  }, [desktop]);
  return <div ref={viewport} className={styles.viewport} role="region" aria-label={desktop ? "YouTube 桌面首页示意" : "YouTube 手机首页示意"} style={desktop && size.height ? { height: size.height + 2 } : undefined}>
    <div ref={canvas} className={desktop ? styles.scaledCanvas : undefined} style={desktop ? { transform: `scale(${size.scale})` } : undefined}>{children}</div>
  </div>;
}

/** 同一份输入同时驱动内嵌和展开视图，关闭弹层自动返回入口焦点。 */
export default function YouTubeFeed(props: Props) {
  const [expanded, setExpanded] = useState(false);
  return <div className={styles.feed}>
    <div className={styles.context}><span>YouTube 首页 · {props.device === "desktop" ? "桌面" : "手机"}</span><SurfaceDialog open={expanded} onOpenChange={setExpanded} title="YouTube 首页预览" description="展示效果示意 · 周围为占位内容，实际展示以 YouTube 为准。" trigger={<button type="button" className="btn-ghost">展开预览</button>}>{expanded && <div className={styles.expanded}><FeedScene {...props} /></div>}</SurfaceDialog></div>
    <div className={styles.compact + (props.device === "mobile" ? " " + styles.compactMobile : "")} role="region" aria-label={props.device === "desktop" ? "YouTube 桌面卡片示意" : "YouTube 手机卡片示意"}><FeedCard {...props} /></div>
    <p className={styles.scrollHint}>当前卡片完整展示；展开可查看首页中的位置。标题按两行截断，下方可查看全文。</p>
  </div>;
}
