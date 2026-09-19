/** 公开客户端下载页：固定已校验的 Windows 安装包，安装步骤与产品示例不含用户数据。 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { LiveNestLogo, DeviceIcon, ExternalLinkIcon } from "../components/icons";
import "./download.css";

export const metadata: Metadata = { title: "下载 LiveNest — 你的直播工作室", description: "下载 LiveNest Windows 客户端，内置独立便携 OBS，在网页管理多台电脑和多个 YouTube 直播频道。" };
const installer = "/downloads/0.1.1/LiveNest_0.1.1_x64-setup.exe";

/** 服务端静态展示，未登录用户也可下载安装包；实际工作台仍需登录。 */
export default function DownloadPage() {
  return <div className="download-page">
    <a className="skip-link" href="#download-main">跳转到下载内容</a>
    <header className="download-nav"><Link className="download-brand" href="/download"><LiveNestLogo width={30} height={30} />LiveNest</Link><nav aria-label="下载页导航"><a href="#getting-started">使用指南</a><Link href="/">打开工作台 <ExternalLinkIcon /></Link></nav></header>
    <main id="download-main">
      <section className="download-hero" aria-labelledby="download-title">
        <div className="download-hero-inner">
          <div className="download-copy"><p className="download-eyebrow">OBS × YOUTUBE · WINDOWS 客户端</p><h1 id="download-title">LiveNest<span>你的直播，<br />在这里就位。</span></h1><p className="download-intro">电脑运行 OBS，网页掌控全局。<br />让设备、频道和素材，各就各位。</p><a className="download-primary" href={installer} download><DeviceIcon width={21} height={21} />下载 Windows 版 <span aria-hidden="true">↓</span></a><p className="download-meta">v0.1.1 · Windows x64 · 378.5 MiB</p><p className="download-included">内置独立 OBS，无需提前安装。</p></div>
          <figure className="download-visual"><div className="download-window-bar"><LiveNestLogo width={17} height={17} /><span>LiveNest Studio</span><span className="download-window-dots" aria-hidden="true">•••</span></div><Image src="/download/workspace.png" alt="LiveNest 网页工作台示例：分别管理同一电脑的 OBS 和频道" width={1280} height={820} priority unoptimized /><figcaption>工作台界面 · 示例数据</figcaption></figure>
        </div>
        <div className="download-capabilities"><span>一台电脑，多个独立 OBS</span><span>每个实例，独立连接频道</span><span>素材上传，支持断点续传</span></div>
      </section>
      <section className="download-steps" id="getting-started" aria-labelledby="steps-title"><div className="download-section-heading"><p className="download-eyebrow">从安装到连接</p><h2 id="steps-title">三步，搭好你的工作室。</h2><p>在需要运行直播的 Windows 电脑上安装。</p></div><ol>
        <li><span className="download-step-number">01</span><h3>安装客户端</h3><p>下载并打开安装包，安装完成后启动 LiveNest，登录你的账号。</p></li>
        <li><span className="download-step-number">02</span><h3>准备 OBS，粘贴配对码</h3><p>点击“自动准备 OBS”。在网页添加直播电脑，将配对码粘贴到客户端。</p></li>
        <li><span className="download-step-number">03</span><h3>连接频道，添加素材</h3><p>回到网页授权 YouTube，添加视频和音乐，准备好后再开始直播。</p></li>
      </ol></section>
      <section className="download-details" aria-label="安装帮助"><div><h2>一台电脑，也可以有多个直播间。</h2><p>在客户端“本机 OBS”中点击“增加 OBS”，为每个实例连接不同频道。新增前，请结束这台电脑上的直播、上传和授权任务。</p></div><div className="download-questions"><details><summary>已经安装了 OBS，会有影响吗？</summary><p>自动准备使用独立便携版，保留你原有的 OBS。已有 OBS 也可通过客户端手动接入。</p></details><details><summary>更新时需要重新配对吗？</summary><p>关闭 LiveNest 后安装新版，原有配置与配对信息会保留。安装前请完成正在进行的配置和上传。</p></details><details><summary>如何核对安装包？</summary><p>版本 0.1.1 · 396,844,810 字节。SHA-256：</p><code>c278e64eb190774fb77ab6fa222a829817f32dc16125aded0558071dd39c1be0</code><a href="/downloads/0.1.1/build-manifest.json">查看构建清单</a></details></div></section>
      <section className="download-final"><LiveNestLogo width={42} height={42} /><h2>让你的下一场直播，从这里开始。</h2><a className="download-primary" href={installer} download>下载 LiveNest <span aria-hidden="true">↓</span></a></section>
    </main><footer className="download-footer"><span>LiveNest Studio</span><span>Windows 客户端 · OBS × YouTube</span><Link href="/">前往工作台 ↗</Link></footer>
  </div>;
}
