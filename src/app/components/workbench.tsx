/** 常驻直播/发布工作空间：共享导航、保留已访问视图与位置，上传随会话而非路由存活。 */
"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import WorkspaceSidebar from "./workspace-sidebar";
import { VideoIcon, UploadIcon } from "./icons";
import { WorkbenchViewContext, WorkbenchTransferContext, type TransferSummary } from "./workbench-context";
import "./workbench.css";
import { useUrlHref } from "../use-url-state";

/** 首次访问模块时显示局部读取反馈，外层导航始终可用。 */
function LoadingView() { return <div className="main-wrapper" role="status">正在打开工作区…</div>; }
const LiveWorkspace = dynamic(() => import("../console"), { loading: LoadingView });
const PublishingWorkspace = dynamic(() => import("../publishing/publishing-console"), { loading: LoadingView });
type Mode = "live" | "publishing";

/** URL 保留分享与前进后退能力；已访问模块只隐藏，草稿和传输不会卸载。 */
export default function Workbench() {
  const pathname = usePathname(); const mode: Mode = pathname === "/publishing" ? "publishing" : "live";
  // 普通切换保留查询状态；上传定位锚点只用于主动查看传输，避免覆盖之后记住的滚动位置。
  const liveHref = useUrlHref({}, "/workspace").split("#")[0], publishingHref = useUrlHref({}, "/publishing").split("#")[0];
  const [visited, setVisited] = useState<Record<Mode, boolean>>({ live: mode === "live", publishing: mode === "publishing" });
  // 首次进入新模块时同步记住它，避免快速往返导致上一视图卸载。
  if (!visited[mode]) setVisited({ ...visited, [mode]: true });
  const [liveNavigation, setLiveNavigation] = useState<HTMLDivElement | null>(null);
  const [publishingNavigation, setPublishingNavigation] = useState<HTMLDivElement | null>(null);
  const [transfer, setTransfer] = useState<TransferSummary>();
  const positions = useRef<Record<Mode, number>>({ live: 0, publishing: 0 });
  const previous = useRef(mode);

  useEffect(() => {
    const original = window.history.scrollRestoration; window.history.scrollRestoration = "manual";
    return () => { window.history.scrollRestoration = original; };
  }, []);
  useLayoutEffect(() => {
    const changed = previous.current !== mode; previous.current = mode;
    const destination = positions.current[mode];
    /** 恢复位置不使用平滑动画，避免大页面切换出现跨页滚动。 */
    const restore = () => {
      if (mode === "live" && window.location.hash === "#upload-content") document.getElementById("upload-content")?.scrollIntoView({ block: "start", behavior: "instant" });
      else window.scrollTo({ top: destination, behavior: "instant" });
    };
    if (changed) { restore(); document.getElementById("workspace")?.focus({ preventScroll: true }); }
    const frame = changed ? requestAnimationFrame(restore) : undefined;
    const remember = () => { positions.current[mode] = window.scrollY; };
    window.addEventListener("scroll", remember, { passive: true });
    return () => { window.removeEventListener("scroll", remember); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [mode]);

  return <WorkbenchTransferContext.Provider value={setTransfer}><div className="workspace-shell workbench-shell">
    <WorkspaceSidebar label="工作台导航">
      <nav className="workbench-primary" aria-label="工作空间">
        <Link scroll={false} className={"sidebar-link " + (mode === "live" ? "is-active" : "")} href={liveHref} aria-current={mode === "live" ? "page" : undefined}><VideoIcon /><span>直播工作台</span></Link>
        <Link scroll={false} className={"sidebar-link " + (mode === "publishing" ? "is-active" : "")} href={publishingHref} aria-current={mode === "publishing" ? "page" : undefined}><UploadIcon /><span>视频发布</span></Link>
      </nav>
      <div hidden={mode !== "live"} ref={setLiveNavigation} />
      <div hidden={mode !== "publishing"} ref={setPublishingNavigation} />
      {mode === "publishing" && transfer && <Link scroll={false} className="workbench-transfer sidebar-link" href={liveHref + "#upload-content"} onClick={() => window.dispatchEvent(new Event("livenest-open-upload"))}><UploadIcon /><span><strong>{transfer.label}{transfer.percent !== undefined ? ` ${transfer.percent}%` : ""}</strong><small title={transfer.filename}>{transfer.filename}</small></span></Link>}
    </WorkspaceSidebar>
    <div className="workbench-content">
      {visited.live && <WorkbenchViewContext.Provider value={{ active: mode === "live", navigation: liveNavigation }}><div className="workbench-view" data-workspace="live" hidden={mode !== "live"} inert={mode !== "live"}><LiveWorkspace /></div></WorkbenchViewContext.Provider>}
      {visited.publishing && <WorkbenchViewContext.Provider value={{ active: mode === "publishing", navigation: publishingNavigation }}><div className="workbench-view" data-workspace="publishing" hidden={mode !== "publishing"} inert={mode !== "publishing"}><PublishingWorkspace /></div></WorkbenchViewContext.Provider>}
    </div>
  </div></WorkbenchTransferContext.Provider>;
}
