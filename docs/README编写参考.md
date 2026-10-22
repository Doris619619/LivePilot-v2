<!-- 文件用途：记录 LiveNest README 重构参考的成熟项目、信息组织方式及实际采用的取舍。 -->
# README 编写参考

阅读日期：2026-10-22。首轮阅读 3 个项目，本轮补充 9 个，共 12 个。比较对象为项目自身的 README，关注读者入口、安装路径、功能组织、截图、文档导航与维护成本；不按星标数量机械套用模板。

## 参考项目

| 项目与来源 | README 中的组织方式 | 对 LiveNest 的启发 |
| --- | --- | --- |
| [Immich](https://github.com/immich-app/immich#readme) | 产品截图、文档与安装入口、演示和功能矩阵。 | 首屏说明产品并展示已有界面；功能表只保留用户可理解的能力。 |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma#readme) | 功能、安装前提、可复制命令、访问地址与更新入口。 | 上手步骤写明环境、动作和执行后应打开的页面。 |
| [OBS Studio](https://github.com/obsproject/obs-studio#readme) | 简短定位，快速链接分别导向使用、构建、开发和反馈。 | 首页承担导航职责，工程和历史细节进入专题文档。 |
| [RustDesk](https://github.com/rustdesk/rustdesk/blob/master/README.md) | 成品下载、自托管入口、源码构建、文件结构与截图分别组织。 | 区分 Windows 安装版用户与源码开发者，不把开发依赖写成客户安装前提。 |
| [Syncthing](https://github.com/syncthing/syncthing/blob/main/README.md) | 产品目标、上手、后台运行、构建与发行验证分别说明。 | 讲清运行职责与数据位置，交付状态指向可核对的发行记录。 |
| [Portainer](https://github.com/portainer/portainer/blob/develop/README.md) | 明确适用对象，提供开始使用、帮助和贡献入口。 | 让使用已有服务、自行部署和参与开发的读者尽早找到路径。 |
| [Jellyfin](https://github.com/jellyfin/jellyfin/blob/master/README.md) | 以用户意图区分下载、使用、问题反馈与贡献，并说明当前仓库包含的组件。 | 明确 LiveNest 产品名与 LivePilot-v2 仓库名，以及网页、Cloud 和 Agent 的关系。 |
| [Owncast](https://github.com/owncast/owncast#readme) | 说明直播软件兼容性，将快速开始与源码构建分开，区分开发分支和稳定发行。 | 写清 OBS 与 YouTube 的职责；不将主分支、安装器和线上状态混为一谈。 |
| [MediaMTX](https://github.com/bluenviron/mediamtx#readme) | 简短产品定位，每项主要能力直接链接到对应功能文档。 | 功能表的条目直接通往直播、发布、预览、互动和恢复指南。 |
| [Home Assistant](https://github.com/home-assistant/core/blob/dev/README.rst) | 短介绍和截图建立产品认知，再链接安装、架构和扩展文档。 | 维持首页的浏览节奏，不在介绍中展开所有配置和协议。 |
| [Dockge](https://github.com/louislam/dockge#readme) | 以具体操作说明能力，提供安装、更新与针对性 FAQ，并解释多 Agent 和文件位置。 | 增加“哪里安装 OBS、能开几路、素材在哪里处理”等选用前常见问题。 |
| [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx#readme) | 演示说明、截图、推荐安装路径、迁移与完整文档相互衔接。 | 示例截图标明合成数据；保持一条清楚的预览路径，深入内容用文档承接。 |

## 本次采用的结构

1. **产品介绍与入口**：一句话定位、仓库范围、下载、工作台、指南和截图。
2. **主要功能**：用实际任务描述能力，并直接链接专题文档。
3. **开始使用**：先按使用、部署、开发分流，再给出环境要求、首次直播和批量发布步骤。
4. **工作原理**：用一张图说明浏览器、Cloud、Agent、OBS 与 YouTube 的职责和数据流。
5. **本地开发**：首页只保留可运行的示例预览命令；真实数据预览、目录与命令表移入[开发指南](开发指南.md)。
6. **部署与升级**：链接完整部署流程和发行证据，不累积逐版变更日志。
7. **常见问题与排障**：先解答选用问题，再按故障现象指向恢复入口。

## 维护约束

- 参考组织方式，不复制其他项目的功能、平台支持、许可证、徽章或服务承诺。LiveNest 的说明以当前代码、配置和发行记录为依据。
- 示例截图继续使用仓库现有资产并标注数据性质；不以空白页面、新绘制的界面或合成数据冒充真实设备验收。
- 首页不增加星标、下载量、赞助和社区入口等与当前使用路径无关的装饰；不虚构许可证或公开演示服务。
- 文档中心保留原专题入口，历史报告中的时点结论由对应发行记录承接。以后新增功能优先维护专题文档，再判断是否值得进入首页。
- README 与文档导航改动检查相对链接、章节锚点、npm 脚本名称和版本描述，并遵循仓库要求运行 `npm run verify`。
