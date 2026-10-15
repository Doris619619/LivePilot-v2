/** 视频发布独立页面，保留直播工作台，沿用现有登录与设备权限。 */
import type { Metadata } from "next";
import AccessGate from "../access-gate";
import PublishingConsole from "./publishing-console";
export const metadata: Metadata = { title: "视频发布 · LiveNest" };
/** 登录后展示素材、配置、排期和发布队列。 */
export default function PublishingPage() { return <AccessGate><PublishingConsole /></AccessGate>; }
