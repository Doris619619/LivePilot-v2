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

功能 [PR #31](https://github.com/Doris619619/LivePilot-v2/pull/31) 已合并为 `d62cb3df8c3773ec05f7822a5cacb06687284e14`；版本 [PR #32](https://github.com/Doris619619/LivePilot-v2/pull/32) 已合并为 `50f4346e6caafe5a8588b17a6bae37130466debd`，稳定标签 `v0.1.13` 指向该正式提交。[标签发行 CI](https://github.com/Doris619619/LivePilot-v2/actions/runs/37802000344) 已成功，[0.1.13 正式安装版](https://github.com/Doris619619/LiveNest-Releases/releases/tag/v0.1.13) 于 `2026-10-08T15:44:21Z` 公开。最终 Cloud `50f4346` 和网站 0.1.13 静态下载已上线，服务器三项安装资产实算与原始 CI 清单、GitHub digest 和更新元数据匹配；客户设备尚未升级，真实频道、在线互动面板及聊天收发未验收。

先上线兼容 Cloud `d62cb3d`，再切换为最终 `50f4346`，服务器完整 verify / build、静态安装资产同步与切换均成功。原 0.1.12 下载仍可访问；既有账号、设备身份、发布数据及同一 OBS 推流的新鲜连续快照保留。项目私有环境中的 DeepSeek Key 已安全配置到服务器进程并实际确认存在，未调用真实 DeepSeek。当前新鲜 Agent 尚未声明聊天能力，原频道 YouTube 授权失效，因此不能把 OBS 推流状态认定为 YouTube 直播已确认或 AI 聊天正在运行。完整部署证据、客户会话检查与待办见 [0.1.13 发布与验收记录](desktop/0.1.13发布.md)。

## 本次自动验证（2026-10-08）

- `npm run verify` 完整通过：98 个测试文件、943 项测试、8 项部署检查、TypeScript、ESLint、Next 生产构建与独立 Agent 构建；交付前最后一轮仍为 943 / 8 通过，本机忽略日志为 `.data/chat-delivery-verify.log`。
- `npm run desktop:compile` 通过：Electron 主进程、preload 和内嵌 Agent bundle 编译成功。[Linux / Windows Verify](https://github.com/Doris619619/LivePilot-v2/actions/runs/37795781089) 在 PR #31 的最终功能 head `34cb12b2e40035adcfbb2a93cb2f81d7bd3b5d18` 通过，Linux 的部署脚本及 Nginx 模板检查也通过。
- [Windows 候选安装器 CI](https://github.com/Doris619619/LivePilot-v2/actions/runs/37795781232) 已执行 `desktop:build` 与真实 NSIS smoke：一次性 Windows 用户下的新安装、静默覆盖升级、保留数据卸载均通过。该功能候选当时仍使用 0.1.12 文件名，不代表正式 0.1.13 标签包或客户旧版升级已通过。
- 版本 PR #32 的 head `abe828f` 已通过 [Linux / Windows Verify](https://github.com/Doris619619/LivePilot-v2/actions/runs/37800680449) 和 [Windows 安装器 CI](https://github.com/Doris619619/LivePilot-v2/actions/runs/37800680604)。[正式标签发行 CI](https://github.com/Doris619619/LivePilot-v2/actions/runs/37802000344) 在确切提交 `50f4346` 成功，正式安装器的 NSIS 新安装、静默覆盖升级、保留数据卸载均实际执行并通过。
- 运行器模拟覆盖默认与保存、欢迎、多语言上下文、取消、旧场次迟到结果、历史及自身过滤、刷屏、限频、100 条溢出、两分钟过期、断线、重启去重、未知发送、存储失败和跨夏令时配额重置。协议验证含本机真实 gRPC 服务及独立 wire 字段断言，均未访问真实 YouTube。
- 访问测试覆盖客户归属、管理员审计、目标设备与实例、新旧能力、过期快照、环境 Key 只向有效 Agent 会话投递、环境轮换和撤销；浏览器 Key 提交被拒绝，公开状态剔除未知私密字段。
- `node tests/live-chat-ui.smoke.mjs` 使用隔离 Next 服务和全部模拟 API，验证 1440px 桌面、390/320px 手机、真实键盘操作与焦点、44px 控件、直播期间独立操作、无 Key 输入、环境未就绪、授权入口、旧 Agent、离线和无页面异常。
- 面板截图全部为示例数据：[桌面](images/live-chat-ai/desktop-1440.png)、[390px 手机](images/live-chat-ai/mobile-390.png)、[320px 手机](images/live-chat-ai/mobile-320.png)。截取面板时仅临时隐藏面板外的固定页头和跳转链接。
- 最终 Cloud 上线后，客户 Do 的临时会话登录和鉴权读取返回 200；该账号没有分配设备，未验收真实在线互动面板。浏览器访问 Agent 环境路由返回 403 且没有密钥，临时会话已撤销；匿名聊天请求返回 401。
- 最终 Cloud `50f4346` 的服务器阶段 verify / build、静态安装资产部署及切换退出码均为 0。真实 TLS Playwright 检查下载页的 0.1.13 链接、健康 200、clean/release 清单 200、安装器 HEAD 200 / Range 206 / `MZ`、更新元数据和旧 0.1.12 下载通过。服务器三项资产大小 / SHA-256、`latest.yml` 两处 SHA-512 验证通过；原始 CI 清单由成功 artifact 的 ZIP Range 提取并核对 entry CRC，没有将整份 ZIP 或本地 CI 三资产实算列为通过。
- 仍待客户 Agent 升级、原频道重新授权及真实在线面板、观众收发验收。未执行真实 OAuth、开停播、聊天发送或 DeepSeek 请求；实际语言与人设、关闭网页后的持续互动和真实网络恢复需在用户授权的直播中单独验收。

## 配置同步恢复修正（PR #34，尚未发布）

- 桌面内嵌和独立 Agent 在会话建立后异步同步环境配置；心跳继续驱动失败退避（1、2、4、8、16、30 秒上限，实际检查受心跳节拍约束），不等待新连接。成功后每分钟复查配置变更。
- 同时只保留一个同步请求；错误仅报告安全的 `CHAT_ENVIRONMENT`，恢复后清除，不阻塞直播操作。退出等在途同步完成后再关闭聊天。
- 若密钥已注入但部分实例刷新失败，保留失败实例并在下一次补齐；相同密钥不再无条件跳过，也不重置已成功实例的聊天。
- 面板在默认视图显示运行状态和故障原因。只有授权故障提供频道授权入口；AI 配置/余额和存储故障提供各自说明，可在修复后点击“重试互动”。设置、活动记录和运行说明分别按需展开。
- 自动化使用合成网络、密钥和状态，覆盖同会话恢复、退避、并发合并、退出排空、实例应用失败、错误分类和 UI 操作。不能据此确认真实 DeepSeek 或 YouTube 已打通。

真实验收还需要：发布并安装包含本修正的客户端/Agent、确认设备在线且报告聊天能力、用户恢复原频道 OAuth、管理员确认 DeepSeek 配置/余额/网络、用户授权测试直播与观众留言。随后核对真实收取消息、生成回复、YouTube 返回发送 ID 和观众端显示；再检查多语言与人设、关页持续工作、关闭开关取消排队、断网重连与重启不重复发送。本次未执行上述真实操作。
