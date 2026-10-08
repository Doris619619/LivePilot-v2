<!-- 文件用途：说明 YouTube AI 文字互动的使用、Agent 执行边界、恢复行为和真实验收要求。 -->
# 直播 AI 观众互动

## 使用

在直播工作台展开目标电脑和 OBS 实例，进入独立的 **AI 观众互动** 面板。聊天设置在直播期间也可以操作，不占开停播控制锁。

- 首次使用默认开启。部署环境的 DeepSeek 配置就绪、该实例的 YouTube 频道正在直播且聊天可用时，Agent 自动开始互动；显式关闭会跨场次和重启保留。
- 选择友善陪聊、活泼幽默、安静温柔或自定义，并填写补充人设。回复跟随观众留言的语言，以当前直播频道发送，包含 `[AI]` 和观众称呼。
- 尽量回应每条新文字留言，并欢迎首次发言的观众。聊天接口不提供所有未发言观众的进入名单。儿童内容或关闭聊天的场次无法互动。
- 发送间隔默认 5 秒，可调为 5–60 秒；没有每日发送条数上限。队列最多 100 条，超过 2 分钟及溢出的旧留言会跳过，面板展示累计发送、跳过、排队数量与最近 30 条互动。
- 直接使用管理员部署环境的 `DEEPSEEK_API_KEY`，用户无需输入 Key。网页不提供聊天 Key 保存入口，只返回环境是否就绪；已有实例 `deepseek.enc` 不作为聊天密钥来源，原英文文案功能的密钥规则保留。

开关“已开启”与运行状态分别显示：环境未就绪、等待直播、连接中、运行中、重连中、聊天不可用、等待配额恢复或需要处理。环境未就绪时明确提示“直播电脑的 DeepSeek 环境配置未就绪，请联系管理员”，不要求用户填写 Key。设备离线时网页显示状态未知，不把旧快照作为当前运行证据。

## 配额与成本

聊天会调用 DeepSeek 付费 API。YouTube 当前每条 `liveChatMessages.insert` 消耗 50 单位，同一 Google 项目的频道共享配额；默认普通接口桶为每日 10,000 单位。没有应用层每日上限并不代表无限配额，聊天耗尽额度也可能影响同项目其他 YouTube 操作。

每日配额耗尽后暂停互动，按 `America/Los_Angeles` 的午夜恢复；发送限流和临时网络故障使用退避重试。面板提供错误原因与处理入口，不显示上游原始请求或错误正文。

来源：[YouTube 配额](https://developers.google.com/youtube/v3/determine_quota_cost)、[聊天发送](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/insert)、[长连接接收](https://developers.google.com/youtube/v3/live/streaming-live-chat)。官方配额表未单独列出 `streamList` 成本，本功能不承诺它免费。

## 运行与恢复

每个实例拥有独立运行器、设置、队列和加密检查点。独立 Agent、桌面内嵌 Agent 与单机 local 服务均由进程启动聊天，关闭网页不会停止互动；Cloud 管理身份、配置投递与状态，不持有 YouTube 令牌，也不调用聊天 AI。

首次启用只处理启用之后的新留言。同场断线使用持久化游标恢复；消息 ID 去重，本频道消息和重复刷屏被过滤。模型获得有限的本场对话，观众文本不能覆盖系统规则，模型没有 OBS、开停播或其他控制工具。

发送前重新确认设置与场次，并先保存发送中记录。发送成功保存 YouTube 返回的消息 ID；超时、断线或进程崩溃造成结果不确定时，不自动重发该条消息。应用不会声称 YouTube 支持 exactly-once 发送。关闭开关、停播、换场次或退出进程会取消生成并清空待发送内容；已提交给 YouTube 的消息无法通过关闭开关撤回。

Key 无效、余额不足或授权失效时暂停并等待处理，避免持续付费重试。管理员修正环境配置并重启服务或重新开启后检查条件；重新授权原频道也会解除授权暂停。聊天关闭时等待可用的新场次。客户只操作自己的设备，管理员通过相同目标入口协助；设置操作记录操作者、实例及结果，审计不记录消息或密钥内容。

## 接口、升级与验收

`POST /api/live-chat` 接受 `read`、`configure`，显式指定实例，Cloud 模式还须指定设备。配置包含 `enabled`、`preset`、`customPrompt` 和 `intervalSeconds`。读取与保存配置返回受限聊天状态，浏览器提交 Key 被拒绝。

管理员在 Cloud 的服务环境设置 `DEEPSEEK_API_KEY`，新 Cloud 会声明 `live-chat-v1`。持有已配对 Bearer 和有效设备会话的 Agent 通过 `POST /api/agent/live-chat-environment` 获得环境配置，响应禁止缓存并拒绝浏览器 Origin；Key 仅进入 Agent 进程环境，不经桌面 IPC 回传、不保存为客户实例 Key。Cloud 只交付环境配置，DeepSeek 调用仍在 Agent。

独立 Agent 也可由管理员在 `.env.agent` 设置同名变量；桌面 Agent 继承宿主进程的环境，单机 local 使用 `.env.local` 或服务环境。新 Cloud 提供 Key 时以部署环境为准；旧 Cloud 没有能力字段时不请求新路由，保留管理员提供的 Agent 环境。环境变更须重启相关服务，用户不用填写 Key。

运行依赖 `@grpc/grpc-js` 和 `@grpc/proto-loader` 纳入生产依赖，桌面 Agent 将其打入内嵌 Node bundle。官方 `streamList` 的必要 protobuf 字段描述内嵌于代码，部署不依赖外置 `.proto` 文件或运行时下载协议资源。

新 Agent 在心跳的 `configuration.liveChat` 中声明能力，并提供可选 `liveChat` 状态。旧 Agent 心跳继续兼容；网页提前显示升级提示，不向旧版本投递未知任务。升级顺序为 **Cloud → Agent / 桌面安装器**，保留原数据目录、实例 ID、OBS 设置、加密密钥和频道授权。回退保留新增聊天检查点，旧版本不会执行聊天。

自动验证使用合成频道、消息、授权与模拟 gRPC/HTTP。测试通过、构建成功和界面截图都不能证明真实观众收到回复。真实验收须由用户完成或授权实际直播与聊天发送，再检查观众端显示、不同语言、关闭网页后的持续运行、关闭开关及断线恢复。

功能 [PR #31](https://github.com/Doris619619/LivePilot-v2/pull/31) 已合并为 `d62cb3df8c3773ec05f7822a5cacb06687284e14`，正在准备 0.1.13 正式发行。截至此发布准备记录，Cloud 待部署、`v0.1.13` 正式安装器待标签 CI 与公开发布、用户设备待升级；真实聊天收发未验收。部署完成后应按实际证据更新 [0.1.13 发布与验收记录](desktop/0.1.13发布.md)。

## 本次自动验证（2026-10-08）

- `npm run verify` 完整通过：98 个测试文件、943 项测试、8 项部署检查、TypeScript、ESLint、Next 生产构建与独立 Agent 构建。
- `npm run desktop:compile` 通过：Electron 主进程、preload 和内嵌 Agent bundle 编译成功。[Linux / Windows Verify](https://github.com/Doris619619/LivePilot-v2/actions/runs/37795781089) 在 PR #31 的最终功能 head `34cb12b2e40035adcfbb2a93cb2f81d7bd3b5d18` 通过，Linux 的部署脚本及 Nginx 模板检查也通过。
- [Windows 候选安装器 CI](https://github.com/Doris619619/LivePilot-v2/actions/runs/37795781232) 已执行 `desktop:build` 与真实 NSIS smoke：一次性 Windows 用户下的新安装、静默覆盖升级、保留数据卸载均通过。该功能候选当时仍使用 0.1.12 文件名，不代表正式 0.1.13 标签包或客户旧版升级已通过。
- 运行器模拟覆盖默认与保存、欢迎、多语言上下文、取消、旧场次迟到结果、历史及自身过滤、刷屏、限频、100 条溢出、两分钟过期、断线、重启去重、未知发送、存储失败和跨夏令时配额重置。协议验证含本机真实 gRPC 服务及独立 wire 字段断言，均未访问真实 YouTube。
- 访问测试覆盖客户归属、管理员审计、目标设备与实例、新旧能力、过期快照、环境 Key 只向有效 Agent 会话投递、环境轮换和撤销；浏览器 Key 提交被拒绝，公开状态剔除未知私密字段。
- `node tests/live-chat-ui.smoke.mjs` 使用隔离 Next 服务和全部模拟 API，验证 1440px 桌面、390/320px 手机、真实键盘操作与焦点、44px 控件、直播期间独立操作、无 Key 输入、环境未就绪、授权入口、旧 Agent、离线和无页面异常。
- 面板截图全部为示例数据：[桌面](images/live-chat-ai/desktop-1440.png)、[390px 手机](images/live-chat-ai/mobile-390.png)、[320px 手机](images/live-chat-ai/mobile-320.png)。截取面板时仅临时隐藏面板外的固定页头和跳转链接。
- 发布准备尚待最终版本提交与 `v0.1.13` 标签 CI、公开资产校验、Cloud 部署和客户 Agent 升级。观众端收发、模型实际语言与人设效果、关闭网页后的持续互动、真实网络恢复仍需在用户授权的直播中单独验收。
