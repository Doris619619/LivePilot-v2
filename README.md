<!-- 文件用途：LiveNest 下载、配置和开发文档导航。 -->
# LiveNest

在网页选择素材、授权频道并控制直播；Windows 客户端配置本机 OBS、运行 Agent 和检查故障。支持多台电脑，每台可使用多个独立 OBS。

**[下载 Windows x64 安装版](https://github.com/Doris619619/LiveNest-Releases/releases)** · **[打开网页工作台](https://livenest.duckdns.org/#workspace)**

安装版内置 Node、Agent、OBS 和离线图解。直播电脑不需要另装 Node、Git 或 Docker。首个公开版本为 [LiveNest 0.1.0](https://github.com/Doris619619/LiveNest-Releases/releases/tag/v0.1.0)。

开发分支补充 OBS 实例识别、步骤内进度与重试反馈，与网页一致的设置页布局，以及 Threadline 式顶部更新入口；尚未发布到 0.1.0，详见[本次验证记录](docs/desktop/OBS准备反馈修复.md)。

| 需要做什么 | 文档 |
| --- | --- |
| 安装、登录、配置 OBS、配对、网页操作和故障恢复 | [桌面配置与网页协作](docs/桌面配置与网页协作.md) |
| 开发预览、NSIS 打包、GitHub 发布和更新 | [桌面安装与发布](docs/桌面安装与发布.md) |
| 手动安装 Agent / OBS 点击图解 | [配置.md](配置.md) |
| 本地模式与旧配置 | [本地模式与多实例](docs/本地模式与多实例.md) |
| 云端从零部署 | [从零部署](docs/从零部署.md) |
| 多电脑和远程控制原理 | [多电脑云端与 Agent](docs/多电脑云端与Agent.md)、[远程控制与素材上传](docs/远程控制与素材上传.md) |
| 架构、开发规范与验证 | [架构](docs/ARCHITECTURE.md)、[工程协作规范](docs/工程协作规范.md)、[PR 规范](docs/PR撰写规范.md)、[桌面验收记录](docs/desktop/验证记录.md) |

本仓库为 [Doris619619/LivePilot-v2](https://github.com/Doris619619/LivePilot-v2)，独立于旧 LivePilot。开发验证：`npm.cmd ci` → `npm.cmd run verify`。真实频道授权及音画验收由用户主动完成。
