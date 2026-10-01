<!-- 文件用途：普通视频发布模块的启用、运行、恢复、合规与真实频道验收说明；区分实现和上线证据。 -->
# YouTube 普通视频批量发布

Cloud 保存用户确认的发布意图；Windows Agent 直接读取本地视频并上传；YouTube 执行已回读确认的 `publishAt`。视频字节不经过 Cloud。模块复用现有账号、设备归属、实例授权和文件存储，没有引入数据库、Redis、FFmpeg 或通用 Job/Run 平台。

本次为功能代码交付，**未部署、未发布桌面安装器、未进行真实 OAuth、上传或广播**。通知使用持久队列状态、报告序号与审计；SMTP 留作后续阶段，未配置邮件不会影响发布流程。

## 入口与启用

1. 先更新 Cloud，再更新 CLI / 桌面 Agent。新 Agent 声明 `publishing-v1`；旧 Agent 保留直播操作，但不能接收发布任务。构建后的 `dist/agent.cjs` 与桌面客户端共用 PublishingRunner。
2. 从工作台进入 `/publishing`。先阅读并同意当前隐私政策；`/privacy`、`/terms` 无需登录且全站有入口。管理员必须配置隐私联系地址。
3. 管理员在“发布策略”开启模块，先使用 **private** 配置。默认 `enabled=false`、`publicVerified=false`。公开需要真实项目验收记录和管理员显式开启；单元测试、直播 API 成功或网页检查均不能替代该记录。
4. 用户将视频提前存入所选 Agent 的 `videos`，PNG/JPEG 缩略图存入同一素材根目录的 `thumbnails`。扫描只读取属性和图片文件头；视频 SHA-256 只在准备上传时流式计算，重启恢复重新校验，已验证值按文件版本缓存。
5. 选择设备、已绑定频道和 Profile，选择、排序视频后生成服务端预览。确认页显示可见性、排期、临时私密标题说明、AI/兜底规则与 YouTube Terms / Community Guidelines 提示。可逐项覆盖标题、说明和匹配封面。
6. 确认后 Profile 快照、素材版本和 UTC 时刻固定。日历、队列和历史共用缓存状态。修改 Profile 不影响已有批次；改期和运行策略形成任务新修订，收到 Agent 回报后才显示已应用。

界面沿用直播工作台的侧栏、配色与控件。素材清单只展示文件、大小和选择顺序；确认页一次编辑一个视频。播放列表、高级参数和任务详情折叠，操作说明只在暂停已定时任务、取消或撤销时出现。月历支持切换月份、显示时区和单日清单，显示选择不修改 UTC 排期。

界面截图使用 **合成示例数据**，不代表真实频道或上传结果：[桌面确认页](screenshots/publishing/confirmation-desktop.png)、[手机月历](screenshots/publishing/calendar-mobile.png)。

## 产品策略与配额

| 设置 | 初始值 | 归属 |
| --- | ---: | --- |
| 提前上传窗口 | 28 天 | Profile |
| 新上传会话 | 20 次/日 | 管理员 / API Project |
| 其他普通发布 API 预算 | 5000 units/日 | 管理员 / API Project |
| 每台机器并发 | 1 | Agent 策略，允许 1–4 |
| 常规 / 明确直播带宽 | 20 / 5 Mbps | Agent 整机合计 |
| 提交排期提前量 | 600 秒 | 发布策略 |
| 分块大小 | 8 MiB | 256 KiB 整数倍 |
| 批量视频状态查询 | 50 个 ID | 同频道、同授权上下文 |
| processing / 远期排期查询 | 60 / 1800 秒 | 接近公开时提高频率 |
| Cloud Scheduler | 60 秒 | Node 启动钩子，单进程单循环 |

这些是产品默认值，可配置，**不是 YouTube 官方限制**。配额账本按项目和太平洋时间配额日跨频道汇总。派发前预留一次新会话及元数据、封面、Playlist、初始查询的估算；请求 admission 先落盘，再消耗预留转为已用。重复 receipt 不重复记账，未知远端结果不退回已用预算。整理完成、暂停、人工介入或删除时释放剩余预留。长时间 processing 产生的额外查询仍逐次 admission，估算不保证无限重试都有预算。预算不足单独显示 Cloud 阻塞原因，不伪造 Agent 状态。

本模块只记录自己的调用，现有直播等用途需要在总项目配额中另留预算。管理员须保证同一配额组对应真实项目，不能通过改组或轮换项目规避限制。2026-10-01 核对的[官方配额正文](https://developers.google.com/youtube/v3/determine_quota_cost)将上传列为独立桶；实际项目设置和剩余额度以 Console 为准。页面的旧自动摘要仍提及旧成本，不能据此硬编码。

## 状态与恢复

核心顺序为上传、续传、状态恢复、processing、封面 / Playlist、最终 metadata / `publishAt`，再观察真实公开。

```text
ready → generating_metadata → uploading → processing → finalizing
      → scheduled → published
private / unlisted：finalizing → completed
retry_wait → 原阶段；needs_attention / paused / cancelled / failed
```

初始 `videos.insert` 永远私密且不提交 `publishAt`。临时标题包含唯一任务恢复标识；会话 URI 加密、同步落盘后才传字节；末块发送前持久保存“可能已发送”。服务器 308 Range 决定 offset，不能按本机发送数推进。全部字节已接收但 videoId 尚未返回时继续探测原 session，不发送空块，也不重新 insert。session 失效且末块可能完成时，精确核对所属频道 uploads playlist；只有唯一匹配才恢复关联，缺失或歧义均等待人工，禁止创建第二次上传。已有 videoId 只恢复整理阶段。

更新保留同一 part 的其他可写字段，排期按实际时刻比较而非字符串格式。`scheduled` 只表示 YouTube 已回读确认，只有真实观察到 `public` 才是 `published`。缺失查询结果不推断删除。页面打开不会逐视频请求；普通状态查询按频道分组、ID 列表分批，id 模式不带分页参数。最终写入前后的单视频回读用于避免覆盖字段和确认副作用。

普通上传不要求 OBS 正常。没有 OBS 或 Unknown 时按常规速率运行；明确推流 / YouTube live / OBS reconnecting 时使用保护带宽，多并发分摊整机上限。AI 文案生成后持久保存；暂时性失败最多额外两次，之后使用用户已同意的合法兜底。儿童内容由用户明确选择。

暂停只停止本地后续工作，不清除远端排期。取消需核对未知末块、清除尚未公开的 `publishAt` 并回读；已经公开的不自动下架。无法确认的取消不标为可重新排队的 cancelled。迟到只调整该任务实际生效时刻，不顺延整个批次。人工 Studio 改动触发核对 / 人工处理，不自动覆盖已确认排期。

## 授权、删除与保存期限

在“授权与数据”提交撤销及删除。Cloud 删除发布记录并停止派发，记录七日处理期限；Agent 优先停止该实例发布、等待旧执行安全结束、清理检查点与 API 日志、移除本地凭据并调用 Google revoke。网络失败保留加密撤销凭据供重试，禁止重新授权；Google 确认后清理绑定并回报完成。源视频、OBS 配置和 DeepSeek 配置保留。已确认无效授权的发布报告也进入优先清理。

离线显示等待设备清理，过期显示超期联系管理员。**不能保证未开机设备的文件在七日内自动消失**；运营者须联系设备负责人在期限内完成，Google / Agent 确认前不能宣称全部删除。

模块视频 API 观察数据超过 30 天则移除；Agent 保留禁止重复上传的执行标记并进入人工处理。用户自己确认的素材、文案、计划和目标身份属于发布意图，不能当成新鲜远端观察数据。外部撤销在重新联网请求时可检测，持续断电的设备不能主动检测。撤销共享实例授权会影响直播 API 控制，**已提交的 YouTube 定时视频仍可能公开**，不会自动取消或删除。

## Phase 0 与真实人工验收

以下全部 **待用户授权后实测**。应使用隔离的测试部署、当前 Google Cloud Project 和明确测试频道；测试环境的公开开关不能复制为生产验收结论。没有 API Compliance Audit 能力时可继续私密上传和恢复开发，公开验收保留阻塞，不使用 Studio 浏览器自动上传绕过限制。

| 项目 | 需要记录的真实证据 |
| --- | --- |
| 合规入口 | 运营者信息、隐私联系地址、最终确认提示、AI 同意和撤销入口可用 |
| 项目与 OAuth | Project / OAuth 发布状态、Scope、实际 Console 配额、长期 refresh |
| 字符边界 | 100/101 ASCII、普通 astral emoji、旗帜、ZWJ、组合音标；API 接受结果及错误码，不能保存原始凭据或请求 |
| 上传 / 续传 | 私密视频、处理中状态、真实断网、跨进程重启后的同 session 续传 |
| 未知末块 | 响应丢失后的 probe / uploads playlist 精确关联，没有第二次 insert |
| 整理 | 手工缩略图、Playlist 独立重试、元数据字段保留 |
| 自动公开 | `private + future publishAt` 回读；关闭 Agent 后由 YouTube 按时公开 |
| 多频道 | 两个实例分别授权、上传和核对，不串号；同频道批量及缺失 ID |
| 直播并行 | 用户授权的真实直播与限速上传同时运行，整机带宽和连续性 |
| 删除与滚动 | Agent / Cloud / Google 清理；离线待处理；跨多日 28 天滚动补充 |

标题当前使用 Unicode 码点，描述 5000 UTF-8 bytes，Tags 计入逗号与含空格标签的引号；用户内容不静默截断。官方只明确 100 characters，真实 Unicode 算法仍待校准，不能把单元测试当成官方接受结果。

参考：[API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service)、[Developer Policies](https://developers.google.com/youtube/terms/developer-policies)、[视频字段](https://developers.google.com/youtube/v3/docs/videos)、[resumable](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)、[update](https://developers.google.com/youtube/v3/docs/videos/update)、[API Audit](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)。

## 本轮验证与回退

已通过完整 `npm run verify`：类型、lint、469 个测试、8 项部署检查、Next.js / Agent 构建。新增专项覆盖 Unicode / UTF-8 / Tags / DST、惰性 Hash、文件变化、无 OBS 与直播限速、308 和失效 session、末块未知、报告确认、批量缺失状态、暂停 / 取消、Profile 快照、窗口派发、权限 / 归属变更、配额预留与未知计账、无 SMTP / AI Key 的兜底。

浏览器 smoke：在本地生产构建上检查 320 / 390 / 1024 / 1440 宽度、隐私同意、Profile、排序、人工覆盖、100/101 emoji 无 maxlength、上传确认、已接收但未暂停时的等待状态、取消等待、月历切换、离线删除等待及法律页。`tests/publishing-ui.smoke.mjs` 的账号 / 设备 / 发布 API 全部模拟，**不证明真实上传**。先以隔离数据目录在 `127.0.0.1:3077` 启动构建，再执行 `node tests/publishing-ui.smoke.mjs`；截图和结果保存在 `.data/publishing-ui/`。

发布文件：Cloud `cloud/publishing/state.json`；Agent `agent/publishing/entries.enc`；使用旧加密密钥。数据增量新增。异常进程遗留的 host / tokens 等锁沿用原人工核对流程；Cloud 发布锁可用 `npm run recover:lock -- main publishing`，只在确认 PID 已退出时清理，不删除日志。普通退出 / 重启自动载入检查点，安全停止会中断活动流式 Hash / HTTP。

回退先关闭新派发、暂停尚在执行的上传并等待安全检查点，然后回退 Cloud / Agent。保存发布日志、原配置和授权，不删除 `.data`。Cloud / Agent 回退不会取消已经提交给 YouTube 的排期；部署清单必须从已回读任务列出仍在远端生效的视频，必要时用户在在线 Agent 或 Studio 显式取消并核对。
