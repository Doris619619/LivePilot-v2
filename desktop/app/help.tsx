/** 随安装包离线提供的 OBS 图解；复用仓库实拍标注，不依赖联网加载。 */
"use client";
/* eslint-disable @next/next/no-img-element -- 本地实拍截图直接离线显示，不使用 Next 图片服务。 */
import { useState } from "react";
const topics = [
  { title: "连接与防火墙检查", image: "websocket.png", steps: ["先在本机 OBS 找到提示中的实例名称，点击对应的启动并检查；这不会开始直播。", "若显示已运行但未监听：在该 OBS 的工具 → WebSocket 服务器设置中启用服务器和身份验证。", "端口冲突或密码错误：结束该 OBS 的直播和录制并关闭窗口，再点击该实例的修复连接。外部手动实例请在原 OBS 修改连接参数。", "防火墙未确认：打开 Windows 安全中心 → 防火墙和网络保护 → 高级设置 → 入站规则，检查该实例的 obs64.exe 路径和提示端口，限制外部入站访问。不要关闭整个防火墙或开放公网端口。", "修改后返回设备配置，点击重新检查。权限不足或超时只代表未能确认，请保留提示供管理员检查。"] },
  { title: "安装与数据位置", image: "", steps: ["下载 setup.exe 后运行安装向导，在安装位置页面选择程序目录。", "首次准备 OBS 前，在设备配置中选择数据位置；默认优先 D 盘，没有 D 盘或不可写时会显示回退原因。", "OBS、素材和运行数据存放在数据目录。设备身份的加密设置保留在 Windows 用户配置目录，升级不会自动迁移。", "已有数据可在设置 → 更改数据位置迁移。先结束直播、上传和授权并关闭 OBS，新目录必须为空；复制完成后原数据仍保留。"] },
  { title: "安装与配对", image: "", steps: ["打开设备配置，点击检查电脑，处理失败项。", "点击自动准备 OBS，等待本机 OBS 检查通过。", "打开网页工作台并登录，点击添加直播电脑，输入电脑名称。", "生成并复制配对信息，返回客户端粘贴，点击连接网页；配对信息 10 分钟有效。", "在网页对应电脑的 OBS 中授权 YouTube 频道，再上传并选择视频和音乐。", "回到客户端完成检查；准备就绪后由你在网页点击开始直播。"] },
  { title: "WebSocket", image: "websocket.png", steps: ["打开需要接入的 OBS，在工具菜单进入 WebSocket 服务器设置。", "启用 WebSocket 服务器并启用身份验证，为同机每份 OBS 设置不同端口和密码。", "新增时在本机 OBS 扫描或浏览选择 obs64.exe，程序会复制成独立实例并自动配置连接。", "连接地址使用本机 127.0.0.1，不需要路由器端口转发。"] },
  { title: "场景与媒体源", image: "add-media.png", steps: ["新建名为 LIVE 的场景。", "点击源面板的加号，选择媒体 → 创建新源，名称填写 VIDEO。", "用相同方式创建 MUSIC；两个源都选择本地文件并勾选循环。", "LIVE 只保留 VIDEO 和 MUSIC 两个直接媒体源，不使用 VLC 源。"] },
  { title: "禁用全局音频", image: "audio.png", steps: ["进入 OBS 设置 → 音频。", "全局音频设备中的桌面音频、麦克风和其他设备全部选已禁用。", "点击应用，再点击确定；只在混音器中静音不等于禁用。"] },
  { title: "画布与帧率", image: "video.png", steps: ["先确认没有推流或录制，再进入设置 → 视频。", "基础画布填写 1920×1080，输出分辨率填写 1280×720。", "常用 FPS 选择 30，保存设置。", "竖屏素材应使用匹配的竖屏画布，不强行拉伸。"] },
  { title: "编码与码率", image: "output.png", steps: ["进入设置 → 输出，选择简单模式。", "初次测试选择软件 x264，视频 4000 Kbps，音频 128 Kbps。", "截图显示的是原机器数值，应按本页文字填写。", "同时运行多个 OBS 时检查 CPU、编码负载和上行带宽。"] },
  { title: "故障与恢复", image: "", steps: ["设备离线：保持客户端运行，检查电脑出站 HTTPS 网络，点击重新连接。", "OBS 连接失败：核对正确的 OBS 是否运行，以及 WebSocket 端口和密码。", "授权失败：返回网页重新授权，确认云端 Google 配置和当前网络可用。", "配置或更新被阻止：结束直播、完成或取消上传，完成正在进行的授权，再重试。", "未知直播状态：检查 OBS 和 YouTube Studio，不重复点击开播，不删除身份或授权文件。", "关闭窗口会收至托盘；电脑睡眠或关机会中断远程控制。"] },
];
/** 章节切换不改变配置，图片可在断网情况下阅读。 */
export default function Help() { const [index, setIndex] = useState(0); const topic = topics[index]; return <div className="desktop-help"><nav aria-label="帮助章节">{topics.map((t, i) => <button className={i === index ? "btn-primary" : "btn-ghost"} key={t.title} onClick={() => setIndex(i)}>{t.title}</button>)}</nav><article><h2>{topic.title}</h2><ol>{topic.steps.map(s => <li key={s}>{s}</li>)}</ol>{topic.image && <img src={"/help/" + topic.image} alt={topic.title + "：编号标注为点击位置"} />}</article></div>; }
