/** 公开客户端下载页：精简下载入口与安装帮助，仅展示公开资产和合成示例。 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { LiveNestLogo, DeviceIcon, ExternalLinkIcon } from "../components/icons";
import "./download.css";

export const metadata: Metadata = { title: "下载 LiveNest", description: "下载 LiveNest Windows 客户端，在网页管理 OBS 和 YouTube 直播。" };
const version = "0.1.5";
const installer = `/downloads/${version}/LiveNest_${version}_x64-setup.exe`;

/** 未登录也能下载；首屏只保留产品、用途和动作，详细帮助按需展开。 */
export default function DownloadPage() {
  return <div className="download-page">
    <a className="skip-link" href="#download-main">跳转到下载内容</a>
    <header className="download-nav"><Link className="download-brand" href="/download"><LiveNestLogo width={30} height={30} />LiveNest</Link><Link href="/">打开工作台 <ExternalLinkIcon /></Link></header>
    <main id="download-main">
      <section className="download-hero" aria-labelledby="download-title">
        <div className="download-hero-inner">
          <div className="download-copy">
            <h1 id="download-title">LiveNest</h1>
            <p className="download-intro">在网页管理你的直播。</p>
            <a className="download-primary" href={installer} download><DeviceIcon width={21} height={21} />下载 Windows 版 <span aria-hidden="true">↓</span></a>
            <p className="download-meta">v{version} · Windows x64</p>
          </div>
          <figure className="download-visual"><div className="download-window-bar"><LiveNestLogo width={17} height={17} /><span>LiveNest Studio</span><span className="download-window-dots" aria-hidden="true">•••</span></div><Image src="/download/workspace.png" alt="LiveNest 网页工作台示例：分别管理同一电脑的 OBS 和频道" width={1280} height={820} priority unoptimized /><figcaption>工作台界面 · 示例数据</figcaption></figure>
        </div>
      </section>
      <section className="download-steps" id="getting-started" aria-labelledby="steps-title">
        <h2 id="steps-title">开始使用</h2>
        <ol>
          <li><span className="download-step-number">01</span><h3>安装</h3><p>在安装向导中分别选择程序和数据位置，再用客户账号登录；升级沿用已有数据位置。</p></li>
          <li><span className="download-step-number">02</span><h3>配对</h3><p>在客户端准备第一个 OBS，再粘贴网页生成的配对码。</p></li>
          <li><span className="download-step-number">03</span><h3>开播</h3><p>在网页连接频道、添加素材，即可开始。</p></li>
        </ol>
      </section>
      <section className="download-details" aria-labelledby="help-title">
        <h2 id="help-title">常见问题</h2>
        <div className="download-questions">
          <details><summary>需要提前安装 OBS 吗？</summary><p>不需要，客户端内置独立便携 OBS；“准备第一个 OBS”会创建独立实例并保留原有 OBS。高级选项也支持扫描、复制和手动接入。</p></details>
          <details><summary>一台电脑能连接多个 OBS 吗？</summary><p>可以。在客户端“本机 OBS”中点击“添加 OBS”，每个独立实例连接不同频道。新增前，请完成这台电脑上的直播、上传和授权任务。</p></details>
          <details><summary>更新时需要重新配对吗？</summary><p>无需重新配对。新版可直接在登录页更新；旧版本若卡在“重启更新”，等待任务完成后从托盘正常退出，再下载新版覆盖安装，保留原数据目录。</p></details>
          <details><summary>如何核对安装包？</summary><p>安装包版本 {version}。构建清单包含文件大小、源码提交和 SHA-256 摘要。</p><a href={`/downloads/${version}/build-manifest.json`}>查看构建清单</a></details>
        </div>
      </section>
    </main>
    <footer className="download-footer"><span>LiveNest Studio</span><Link href="/">前往工作台 ↗</Link></footer>
  </div>;
}
