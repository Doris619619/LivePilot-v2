<!-- 文件用途：普通视频发布模块的启用、运行、恢复、合规与真实频道验收说明；区分实现和上线证据。 -->
# YouTube 普通视频批量发布

Cloud 保存用户确认的发布意图；Windows Agent 直接读取本地视频并上传；YouTube 执行已回读确认的 `publishAt`。视频字节不经过 Cloud。模块复用现有账号、设备归属、OAuth 基础能力和文件存储，没有引入数据库、Redis 或通用 Job/Run 平台；FFmpeg 仅作为 PublishingRunner 的本机发布包预处理。

本次为功能代码交付，**未部署、未发布桌面安装器、未进行真实 OAuth、上传或广播**。通知使用持久队列状态、报告序号与审计；SMTP 留作后续阶段，未配置邮件不会影响发布流程。

## 入口与启用

先更新 Cloud，再更新 CLI / 桌面 Agent。旧 `publishing-v1` 任务继续使用原素材与检查点；发布包要求 `publishing-v2`，独立发布账号要求 `publishing-accounts-v1`。默认 `enabled=false`、`publicVerified=false`；管理员配置隐私联系方式并完成真实项目验收后才能开启自动公开。直播 API、构建和模拟网页不能替代验收。

在“发布视频”选择电脑并点击“添加账号”，单独授权 YouTube 发布频道；同一电脑可保存多个发布账号，每个账号可配置多个内容批次。账号可与直播使用不同频道，授权与凭据保存在 Agent 的独立账号目录；新发布计划必须指定这个账号，不能默默沿用直播授权。重新授权固定原频道，要使用另一个频道则添加新账号。旧已确认任务保持原实例授权和检查点，不自动迁移；Cloud 只保存账号身份和绑定结果，不接触 Token。

用户实际流程固定为四步：

1. **准备素材**：客户在自己的广播电脑，把批次复制到固定 Inbox。网页选择所属电脑，点击“检测素材”，选择一个批次，检查自然排序的所有子文件夹。扫描仅读视频属性，坏包逐项显示；修复后刷新，或明确勾“暂不发布”再继续。
2. **设置时间**：选择已授权频道和发布配置，填写开始日期、IANA 时区和每周时间。各星期可用不同时间，也可同日多个时刻。新批次的公开统一经过定时确认；私密和不公开无需排期。发布时间属于 Plan；Profile 保存文案、AI、可见性、Tags、儿童内容等发布规则。旧 Profile 的排期只用于初始化计划，已有即时公开任务继续遵循原快照。
3. **确认计划**：默认以月历查看视频时间，点击视频修改时间或文案；手机按日期显示日程，也可切换全批次列表逐项核对。主视图保留条数、频道与可见性，首末时间、每周频率和跳过的占用时刻进入折叠详情。自动重排保留手动时间。最终确认保留 AI/兜底同意、临时私密标题与 YouTube Terms / Community Guidelines 提示，用户内容不静默截断。
4. **自动执行**：当前批次显示待处理、正在生成、正在上传、已排期、异常；任务控制和诊断按需展开。“我的发布”默认按权限内的全部频道汇总，频道下展示多个批次的公开/完成进度、待发布、异常、取消和下一条时间，另有日历及历史；已排期与时间已到不等于已公开。配置、授权与管理员策略位于设置。

已到达的步骤可直接点击导航返回，保存已填时间、排除项和文案编辑；内容或规则变化后必须重新检查/生成，不能跳过校验进入旧确认计划。进入第四步后仍可直接返回第二步：确认后的素材、配置和文案只读，时间通过“预览新排期 → 确认改期”修改原任务，不创建新上传。未完成自动项重新分配时间，手动项保持固定；完成、取消中、失败和需人工核对项锁定，暂停仍保持暂停。预览不生效，返回执行保留旧任务；确认后显示等待设备确认，原远端排期在新修订回读前仍占位。刷新恢复同账号当前计划与时间表单，服务端再次检查任务修订与占位。已确认快照不随配置修改改变。网页只通过 Agent 检测固定目录，不提供大文件网页上传或任意本机路径扫描。电脑客户端设置有“打开发布目录”；远程网页显示并复制目标电脑的路径。

“我的发布 → 历史”使用紧凑结果列表：内容、发布包、频道、计划时间和结果对齐，搜索及结果筛选作用于全部缓存记录，再按每页25条显示。一次只展开一项详情，核对状态和查看视频放在详情中；小屏重排为紧凑行。计划时间不是实际公开时间，最近记录表示 Agent 最后报告时间；旧修订已观察到的公开事实不因新指令待确认而隐藏。页面读取不调用 YouTube。布局参考 [IBM Carbon Data table](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) 的工具栏、统一行高和渐进展示。

## 真实目录与发布包

数据根由客户选择，下面以 `D:\LIVENEST` 为例；不是必须使用 D 盘。

```text
D:\LIVENEST
├─ tools
│  ├─ ffmpeg.exe
│  └─ ffprobe.exe
├─ Publishing
│  ├─ Inbox
│  │  └─ 2026-10-Batch-01
│  │     ├─ 001
│  │     │  ├─ video.mp4
│  │     │  ├─ music.mp3
│  │     │  ├─ cover.jpg
│  │     │  ├─ title.txt
│  │     │  └─ description.txt
│  │     └─ 002
│  │        └─ video.mp4
│  ├─ Working
│  │  └─ 2026-10-Batch-01/001/<packageVersion>
│  │     ├─ render.json
│  │     └─ output.mp4
│  └─ Completed
│     └─ 2026-10-Batch-01--<archiveId>
└─ state
   └─ agent/publishing/entries.enc
```

仅支持 `Batch/Package/files`。一个包只能有一个支持的主视频，最多一首音乐；视频支持 MP4/MKV/MOV/WebM/AVI/M4V，音乐支持 MP3/WAV/FLAC/AAC/M4A/OGG。封面为 `cover.jpg/jpeg/png`，文案文件使用 UTF-8；文件大小、格式、链接、嵌套目录、缺视频和多视频等问题逐包指出。标题按现有 Unicode 验证器、说明按 UTF-8 5000 bytes 校验。

字段优先级为人工覆盖、包内文本、已授权 AI、Profile 模板，按标题和说明分别应用。`{{packageName}}` 与 `{{batchName}}` 可以用于默认模板，避免把所有 `video.mp4` / `output.mp4` 变成同名标题。匹配封面有则使用、没有则采用 YouTube 自动缩略图；固定封面沿用所选实例 `media/<instance>/thumbnails`，不存在时明确阻塞。

桌面显式传入 `LIVEPILOT_PUBLISHING_ROOT=<数据根>/Publishing`。CLI 可配置同一变量；未配置时，数据目录末段为 `state` 则取其上级，否则在 CLI 数据根下创建 Publishing。不会把 OBS、Token 或直播素材迁入新目录。

## 合成、文件确认与归档

无音乐直接使用源视频；有音乐只保留源画面，以音乐替换原音轨，循环短音乐、截断长音乐，最终长度按源视频确定。优先复制视频编码，不能装入 MP4 时转 H.264；音乐输出 AAC，不主动修改分辨率和帧率。工具优先使用数据根下 `tools` 中成对的 FFmpeg/ffprobe，再查 PATH，本轮不自动下载。缺工具只阻塞带音乐的包，页面明确提示。

进入 Plan 的滚动窗口后才准备文件，每台设备一次生成一个包，重编码限制线程，明确直播时推迟新的重编码。没有 OBS 或状态 Unknown 不全面暂停普通上传。输出使用包版本隔离，临时文件完成音画、时长及 Hash 校验后原子落位，记录完成才可复用；重启不会仅因 output 文件存在就认定成功。

Cloud 保存发布包输入快照；Agent 保存最终上传文件的路径、大小、修改时间和完整 Hash，先向 Cloud 报告最终尺寸并等待确认，再建立上传会话。原始 Job asset 不被合成文件原地替换。重启验证源包和最终文件，同一会话的 bytes/offset/末块始终绑定固定输出。已有 session、末块未知或 videoId 时，禁止自动覆盖输出或再 insert。

确认后的源内容变化进入人工处理，重新扫描并确认新计划；须先安全取消旧任务并由 Agent 回报。有远端视频的新版本需要用户明确确认“创建新视频，原视频保留”，保留旧任务关联，不自动重复上传。

自动排期跳过 LiveNest 已知的同频道 UTC 时刻，包括原计划、实际生效时间和待确认改期。同批改期也按原 Job 保留旧时刻归属，允许任务保留自身时间，其他任务须等原任务确认改期后才可复用旧 Slot。暂停保留占位；取消经 Agent 确认后释放，未知结果的失败不直接释放。手动时间不被自动重排覆盖，暂不发布的包保留计划但不建立上传任务、不占 Slot。确认事务再次防冲突，竞争失败要求刷新预览，不暗改已显示时间；不能承诺避让未被 LiveNest 记录的 Studio 手工计划。

整批当前版本的每个包都确认 published 或非公开 completed、没有未完成引用后，用户才能手动归档。暂不发布的包须在后续计划完成，旧草稿和安全取消的历史记录不会阻止归档。Agent 复核版本，保存可恢复搬移记录，移动 Inbox 整批到带 archiveId 的 Completed 目录，禁止覆盖同名目录；Working 与上传恢复文件保留，不自动删除。离线/结果未知显示等待确认并可重试同一归档 ID。数据根迁移保留文件时间属性与相对定位。

## 接口与增量兼容

`/api/publishing` 增加 `packages`、`plan-preview`、`plan-update`、`plan-confirm`、`plan-archive`；GET 返回用户当前设备可见的 plans，旧 Profile、Batch、Job 接口保留。Plan 更新使用 revision 并持久保存手动覆盖；重复确认返回原任务。已确认计划使用独立 `plan-reschedule-preview`（planId/revision/rule/items）和 `plan-reschedule-confirm`（planId/revision/previewId），持久预览指纹仅比较任务修订、安全资格及排期占位，上传字节进度不会频繁使预览失效。相同预览确认幂等，单项手动改期同步 Plan 为 manual。原 Job/session/最终文件/videoId/文案保持；旧整理请求迟到不能覆盖新修订，YouTube 条件更新保护刚公开的视频，公开竞态回报真实结果而不重新设为私密。`plan-confirm` 可传 `replaceJobIds`，仅接受当前修订已安全取消、源包版本已改变的替代任务；`plan-archive` 未完成时返回 `{state:"pending",message}`，不能显示归档成功。新版 Agent 指令只接收固定目录包身份及快照，不接收任意 shell/path。报告先固定 prepared 文件描述，再按最终 total 校验进度，旧序号不会覆盖新状态。

独立账号增加 `account-create`、`account-connect`、`account-playlists` 和 `account-cleanup`，Profile 快照的 `accountId` 固定上传授权上下文；只有声明新能力的 Agent 能接收这些任务。账户撤销只停止该账号的新派发并清理该账号记录，离线设备显示待清理，收到 Agent 与 Google 确认后才算完成；旧实例清理不会删除新账号任务。Google 会撤销该用户对本应用的授权，同一 Google 用户的直播与其他频道也可能需要重新连接，操作确认时须提示；不能保证 Google 侧授权完全隔离。已提交的 YouTube 排期不随账号清理自动取消，本地源文件保留。

已有文件状态只增量添加账号、plans 和可选包/最终文件字段，旧文件不删除、不强制重写成新格式。旧 Cloud/Agent 回退前关闭新派发，保留新旧记录；已有 YouTube 排期仍有效。

## 产品策略与配额

| 设置 | 初始值 | 归属 |
| --- | ---: | --- |
| 提前上传窗口 | 28 天 | Plan；旧任务兼容 Profile |
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
ready → preparing_media（发布包）→ generating_metadata → uploading → processing → finalizing
      → scheduled → published
private / unlisted：finalizing → completed
retry_wait → 原阶段；needs_attention / paused / cancelled / failed
```

初始 `videos.insert` 永远私密且不提交 `publishAt`。临时标题包含唯一任务恢复标识；会话 URI 加密、同步落盘后才传字节；末块发送前持久保存“可能已发送”。服务器 308 Range 决定 offset，不能按本机发送数推进。全部字节已接收但 videoId 尚未返回时继续探测原 session，不发送空块，也不重新 insert。session 失效且末块可能完成时，精确核对所属频道 uploads playlist；只有唯一匹配才恢复关联，缺失或歧义均等待人工，禁止创建第二次上传。已有 videoId 只恢复整理阶段。

更新保留同一 part 的其他可写字段，排期按实际时刻比较而非字符串格式。`scheduled` 只表示 YouTube 已回读确认，只有真实观察到 `public` 才是 `published`。缺失查询结果不推断删除。页面打开不会逐视频请求；普通状态查询按频道分组、ID 列表分批，id 模式不带分页参数。最终写入前后的单视频回读用于避免覆盖字段和确认副作用。

普通上传不要求 OBS 正常。没有 OBS 或 Unknown 时按常规速率运行；明确推流 / YouTube live / OBS reconnecting 时使用保护带宽，多并发分摊整机上限。AI 仅补充没有人工/包内内容的字段，文案生成后持久保存；暂时性失败最多额外两次，之后使用用户已同意的合法兜底。儿童内容由用户明确选择。

暂停只停止本地后续工作，不清除远端排期。取消需核对未知末块、清除尚未公开的 `publishAt` 并回读；使用刚回读版本的 `If-Match` 条件更新，公开或并发变更时停止写入，不自动下架。此版本保护依据 [YouTube ETag 文档](https://developers.google.com/youtube/v3/getting-started#using-etags)，真实接口行为仍需测试频道验收。无法确认的取消不标为可重新排队的 cancelled。迟到只调整该任务实际生效时刻，不顺延整个批次。人工 Studio 改动触发核对 / 人工处理，不自动覆盖已确认排期。

## 授权、删除与保存期限

在“授权与数据”提交撤销及删除。Cloud 删除发布记录并停止派发，记录七日处理期限；Agent 优先停止该实例发布、等待旧执行安全结束、清理检查点与 API 日志、移除本地凭据并调用 Google revoke。网络失败保留加密撤销凭据供重试，禁止重新授权；Google 确认后清理绑定并回报完成。源视频、OBS 配置和 DeepSeek 配置保留。已确认无效授权的发布报告也进入优先清理。

离线显示等待设备清理，过期显示超期联系管理员。**不能保证未开机设备的文件在七日内自动消失**；运营者须联系设备负责人在期限内完成，Google / Agent 确认前不能宣称全部删除。

模块视频 API 观察数据超过 30 天则移除；Agent 保留禁止重复上传的执行标记并进入人工处理，Cloud 保留自有 `hadUpload` 执行事实，清除旧 videoId 不等于从未上传。用户自己确认的素材、文案、计划和目标身份属于发布意图，不能当成新鲜远端观察数据。外部撤销在重新联网请求时可检测，持续断电的设备不能主动检测。撤销共享实例授权会影响直播 API 控制，**已提交的 YouTube 定时视频仍可能公开**，不会自动取消或删除。

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

新增验证覆盖发布包轻量扫描、100 包/排序、路径逃逸、音轨循环截断、转码兜底、缺工具、缓存与输出落位崩溃、源/输出变化、最终尺寸握手、旧 session 恢复、多 Slot/DST/占位竞争、手动覆盖、替代确认和归档恢复；独立账号覆盖凭据与 PKCE 隔离、永久频道占位、重启确认、按账号清理、旧实例清理兼容及频道缓存期限。本次增加确认后原任务改期、同批时刻归属、旧请求迟到、公开竞态和历史搜索/筛选回归；素材生成取消测试改用实际 spawn 事件同步，保持原超时和断言并确保失败清理。最终 `npm run verify` 的 76 个测试文件 / 611 个测试、8 项部署检查、类型与 lint、Next.js / Agent 构建通过，桌面编译通过。浏览器验收使用生产构建及合成 API；模拟 FFmpeg command runner 和 YouTube 端口不证明真实工具/频道接受结果。

网页验收覆盖 320/390/1024/1440、100 包分页、四步全流程、点击步骤与草稿/未保存编辑保留、月历/日期清单/列表、多设备多频道总览、同机账号隔离、账号 Playlist 与删除、授权结果回到原账号，以及观察数据过期后的归档门槛。确认后第四步可回到前面步骤，预览不改任务，确认后任务 ID、视频关联、文案与最终尺寸保持；历史100条跨四页、全量搜索/结果筛选、仅展开一个详情及四宽无溢出已通过。28 张截图均为合成数据；localhost 实际代理另通过 100 条任务的检测、排期、确认、第四步回跳及同任务改期和历史表格检查。真实 Windows 工具、独立账号 OAuth、跨进程续传、真实项目 Unicode/Audit、Agent 关闭后公开、真实直播并行及跨多日滚动仍分别人工验收。

发布文件：Cloud `cloud/publishing/state.json`（含 plans）；Agent `agent/publishing/entries.enc`；本机 Working 生成记录和归档记录。继续使用旧加密密钥。异常遗留锁沿用人工核对流程，禁止删除日志来绕过恢复。

回退先关闭新派发、暂停当前生成/上传并等待安全检查点，保留所有状态和原授权。旧版本不能执行新发布包，应保留其记录并等新版恢复。Cloud/Agent 回退不会取消 YouTube 已提交排期；部署清单必须列出仍生效的视频。本轮保持 PR #26 未合并，未部署或发布安装器。
