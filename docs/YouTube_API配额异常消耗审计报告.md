<!-- 文件用途：记录 YouTube 配额异常的源码、只读服务器证据、离线测试、容量计算和修复建议；不代表已修复或完成真实直播验收。 -->
# YouTube API 配额异常消耗审计报告

审计时间：2026-10-19（纽约）；服务器取证：2026-10-20 03:25 UTC。
源码基线：`origin/main f713e6b0b52e57e9036061aefb7f98dc0f82bf76`。审计分支：`docs/20261019-youtube-quota-audit`。
范围：前端、Next 服务、Windows Agent 的桌面与 CLI 入口、直播控制、聊天室、普通视频发布、后台同步、重连与配额账本。**只新增报告和离线审计测试，未修改业务代码、部署、重启服务或操作直播。**

## 1. 两个核心问题的答案

**为什么测试规模很小，也很容易耗尽？**

已证实的主要浪费是：**“没有直播”不等于“没有查询”。授权实例只要保留上一场的 broadcastId / streamId，Agent 即使处于 stopped，也持续触发频道、场次和推流对象三种查询。**默认每 30 秒一组，理想持续运行一天约 **8,640 units / 实例**，已占默认通用日配额的 86.4%。服务器昨天的备份直接证实：主实例停播近两小时后，YouTube 状态仍在刷新。浏览器关闭不停止此后台任务。

但 **单实例仅此三种查询的 8,640/day，小于 10,000/day，不能单独解释一次完整日配额耗尽，更不能证明昨天的精确消耗**。额外聊天室连接、发言、其他电脑/进程、开停播与元数据操作共同消耗项目额度；当前缺少逐请求计量和 Google Cloud 历史曲线，不能把其中某个尚未验证的风险写成唯一现场根因。

另外已用真实运行器和 Mock 复现一个可快速放大的缺陷：聊天室连接若每次收到一批数据后立即结束，会不断重置退避计数，约每秒重新调用一次 streamList；60 秒含两端采样测得 61 次。按当前官方每连接 5 units，单路约 18,000 units/h，仅此约 33 分钟可耗尽 10,000。**这是代码与测试证实的高风险路径，尚无昨天的连接日志证明现场触发过。**

**100 路能否长期稳定运行？**

按当前保留 ID 的状态查询路径，即使完全不发聊天消息，100 路理想持续运行也是 **864,000 units/day**，默认 10,000 约 **16 分 40 秒**耗尽。进程内缓存使调用基本线性增长，没有证据显示正常场景超线性；但这个线性成本已经不能支持 100 路。必须重做状态来源、生命周期查询、全项目预算、熔断与计量，而不只是延长网页刷新间隔。聊天室持续发送还需要单独的大额预算或经官方审批增加配额。

**另一个已证实的严重问题是可观测性缺口。**当前只能知道失败和最后状态，无法回答“哪台设备、哪个功能、何时、因为什么重试花掉多少”。这使精确归因、提前告警及修复后的效果验证都缺少依据，应与止损一起列为 P0。

## 2. 现场证据：服务器昨天发生了什么

### 2.1 取证方式与时间边界

经用户授权，使用既有 SSH 配置只读检查 systemd、当前 release 源码、Cloud 持久快照/任务/发布账本、Nginx 配置、journal，以及服务器上的两个备份。备份通过内存读取 tar 成员，没有解压覆盖生产目录。另只读解析本机加密状态与聊天检查点；没有输出凭据、聊天正文或原始上游异常。

“昨天”按用户纽约日期为 **10 月 18 日 EDT**。下表统一写 **UTC**，避免混淆。Google 配额按 America/Los_Angeles 午夜重置：当时为 UTC 07:00。因此 UTC 10 月 18 日 06:27 停播属于 **Google 配额日 10 月 17 日**；08:16 的持续查询已经跨入 **Google 配额日 10 月 18 日**。不能用 UTC 自然日直接对齐额度。

### 2.2 时间线与直接结论

| UTC 时间 | 服务器/本地记录 | 能支持的结论 |
| --- | --- | --- |
| 10-18 05:02:49 → 05:03:28 | 主电脑 start 成功 | 确有该次开播，不是无限 start 记录 |
| 10-18 06:27:00 → 06:27:10 | stop 成功；状态 stopped，OBS 不推流 | 直播已结束 |
| 10-18 06:54:38 | 06:55 备份里主实例 youtube.checkedAt，lifecycle=complete | 停播后仍在成功查询 |
| 10-18 08:16:07 | 08:16 备份里仍为 stopped、complete，checkedAt 再次更新 | 停播约 1 小时 49 分后继续查询，并跨过一次配额重置 |
| 10-19 06:21:49 → 06:22:27 | 主电脑下一次 start 成功 | 另一次明确用户操作 |
| 10-19 07:04:31 → 07:04:33 | 主电脑 stop 失败，错误码 YOUTUBE_NETWORK | 只能证实网络失败，**不是**“午夜重置后 4 分钟 quotaExceeded”的证据 |
| 10-19 09:52、09:57 | 第二台电脑 stop / start 成功 | 今天存在另一台活跃直播设备 |
| 10-20 02:58:06 | 本轮之前排查保存的单次 HTTP 403 quotaExceeded 记录 | 配额拒绝真实存在；不是本次审计反复请求得到 |
| 10-20 03:25 左右 | 两台有效电脑心跳新鲜：主电脑 OBS=false/phase=error，另一台 OBS=true/phase=live；两者快照均提示 YOUTUBE_DAILY_QUOTA | 当前存在两台活跃 Agent；配额失败与 OBS 是否仍推流是两回事 |

昨天两个备份中，第二台电脑的 heartbeat 都是旧值，授权错误 GOOGLE_AUTH，旧 live 标记不能证明当时在线。**不能把两台电脑都按昨天全天有效运行计算，更不能把理论 17,280/day 写成实测。**主电脑三个 OBS 槽位中只有一个具备授权；另两个无授权，不产生这组 YouTube 查询。

服务器 Cloud 为 **0.1.18**，release 为 `1fabef89cdd385d61b1805c0c835544a282a04f9`，自 10-18 08:16:30 UTC active，systemd NRestarts=0。已逐一比对部署源码与本次基线的 `src/core/service.ts`、`src/core/live-chat/runner.ts`、`src/agent/runner.ts`，规范化换行后的 SHA-256 均一致。此核对只覆盖这三份源码，不代替另一台电脑安装包版本核验。

主电脑实际 OAuth client 与 Cloud 全局 client 的指纹比对相同，仅保留“相同”结论。桌面 Agent 的 `src/agent/desktop-worker.ts:36` 从 Cloud bootstrap 读取该配置；CLI 的 `src/agent/main.ts:19` 也支持本地 .env.agent。**另一台设备实际使用的 OAuth client / Google 项目尚未直接核对**，不能仅凭同一个 Cloud 就断言所有历史调用都属于同一项目。

### 2.3 哪些现场原因得到了削弱，哪些仍不能排除

- 主电脑检查点累计成功发言 **7 条**，其中 UTC 10-18 五条、10-19 06:42 两条；后两条属于 Google 配额日 10-18，按当前成本合计 40 units。另一电脑当前快照累计 3 条。**累计成功条数不是每日账单，也不包含未知结果/失败调用；但现有记录不支持“大量成功 AI 发言耗尽昨天额度”的说法。**
- 主电脑两个普通发布任务均已 published，本机下一次远端核对在 10-31，最近核对在 10-07。Cloud 发布账本最近一条也是配额日 10-07，4 units、0 uploads；10-18/19 未见新发布额度准入记录。**这削弱了普通发布轮询造成最近风暴的假设，但发布账本不覆盖其他业务。**
- 保留下来的近期控制任务没有大量重复 start。非 control 任务会在完成约 10 分钟后清理（`src/cloud/tasks.ts:54`），所以没有旧记录不代表从未执行。
- LiveNest 的 Nginx server 块配置 **access_log off**；通用 access.log 中的扫描器 404 不是用户业务流量。journal 检查窗口只有 28 条记录，没有逐次 YouTube 调用与 quota 命中时间序列。
- Cloud 持久化的是最近快照，会被覆盖；目前无法反推出昨天第一次 quotaExceeded 的准确时间、历史 gRPC 重连次数、每方法调用量或其他使用同项目的应用。
- OBS 推流字节、观看页面播放、浏览器上传素材到 Agent、DeepSeek 试聊都不能直接当作 Data API units。截图中的网络失败与配额提示也不能自动归为同一个故障。

可公开的筛选证据见 [审计数据](audits/youtube-quota-evidence.json)。原始本地取证材料保留在本工作树被 Git 忽略的 `.data/youtube-quota-audit/`；它不是正式请求日志，也不应整包公开。

## 3. 官方配额规则：本次采用的版本

检索日期 2026-10-19；[官方配额成本表](https://developers.google.com/youtube/data/determine_quota_cost) 页面更新日为 2026-10-15。实际项目可能获批不同额度，应以其控制台为准。本报告按最新默认值建模：

| 配额桶 | 当前默认 | 本仓库相关成本 |
| --- | --- | --- |
| 通用 Data API | 10,000 units/day | 普通 list 多数 1；liveBroadcasts 的 list/insert/update/bind/transition 与 liveStreams list/insert 均 1；videos.update、playlistItems.insert、thumbnails.set 各 50 |
| Live Chat，计入通用桶 | 同上 | streamList 每次调用 5；insert 每次 20 |
| 视频上传独立桶 | videos.insert 100 calls/day | 每次占 1 上传调用；不能再用旧 1,600 通用 units 估算 |
| 搜索独立桶 | search.list 100 calls/day | 全仓未找到生产 search.list 调用；不应作为当前根因 |

具体参见 [streamList 方法](https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages/streamList)、[聊天 insert 方法](https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages/insert)、[videos.insert 方法](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert)。streamList 是长连接调用，**同一连接里的每个消息批次不是再次调用**。OAuth token 刷新、授权页和 revoke 不按 Data API 方法计费；授权完成后的 channels.list 则计费。

失败请求也可能消耗配额；官方说明无效请求至少计 1。网络异常若发生在发出之前可为 0，超时也可能已被服务端处理。**本地尝试次数、HTTP 请求数和最终计费 units 必须分开，不把所有失败统一当成方法成功成本或统一当 0。**已耗尽后的拒绝次数也不是“又从剩余额度扣掉了相同额度”的证明。

## 4. 全量调用清单与触发链

以下为基线文件的一基行号。没有把含 YouTube 字样的 UI、RTMPS 推流、代理转发或 Mock 测试算成额外上游调用。共同底层 `YouTubeApi.request` 位于 `src/core/youtube/api.ts:37`，单次超时 20 秒，不内建无限重试；也没有全项目限速、预算或熔断。

### 4.1 直播、授权与聊天

| 上游方法 / 单次成本 | 代码位置 | 业务触发与频率 | 缓存、去重、预算及重复点 |
| --- | --- | --- | --- |
| channels.list / 1 | `src/core/youtube/api.ts:56` | 每次 dashboard 的 YouTube 缓存失效；开/停播与恢复也直接读 | dashboard TTL 30 秒；直接控制调用不共享该频道缓存，无项目预算 |
| liveBroadcasts.list 按 ID / 1 | `api.ts:61` | dashboard、聊天目标观察、开停播核对 | `service.ts:79` 缓存 30 秒并合并在途，聊天与 dashboard 共享；Control 直接读不共享 |
| liveStreams.list 按 ID / 1 | `api.ts:65` | dashboard；开播前与等待 ingest | dashboard 30 秒；Control 直接等待默认 3 秒一次 |
| liveBroadcasts.insert / 1 | `api.ts:70` | 新场次 start | 先持久化创建意图，结果未知先恢复查询，不自动重建 |
| liveStreams.insert / 1 | `api.ts:120` | 无可复用推流对象的 start | 保存意图与 streamId；后续场次可复用 |
| liveBroadcasts.update / 1 | `api.ts:99` | prepareBroadcast 应用标题/权限等 | detailsApplied 成功后跳过；失败再试可能重走部分准备 |
| liveBroadcasts.bind / 1 | `api.ts:138` | start 发现绑定不符 | 只在需要时调用，随后再读确认 |
| liveBroadcasts.transition / 1 | `api.ts:141` | start→live、stop→complete | 操作阶段调用，读回确认；无自动无限写重试 |
| liveBroadcasts.list / liveStreams.list 历史分页 / 每页 1 | `api.ts:125–137` | 创建结果未知、恢复/清理；按标题匹配 | 每页 50；**没有页数、总时限或重复 pageToken 防护** |
| playlists.list / 每页 1 | `api.ts:79` | UI 明确读取列表；prepareBroadcast 校验归属 | 每页 50；结果 >1,000 报错；无共享缓存，空页重复 token 可绕过结果数限制 |
| playlistItems.list / 1；insert / 50 | `api.ts:115–117` | 直播详情选定每个播放列表 | Set 去重列表；先查再添加，重复准备不盲目重复 insert |
| thumbnails.set / 50 | `api.ts:107` | 直播准备且配置封面 | 单次上传；失败归为通用 YOUTUBE_API，**未统一识别 quotaExceeded**；用户重试会再次走准备 |
| channels.list / 1 | `src/core/youtube/auth.ts:99` | 每次成功 OAuth finish 确认原频道 | 不是每次 access token 刷新；access 刷新有在途合并 |
| liveChatMessages.streamList / 5 | `src/core/youtube/live-chat.ts:86,102` | 聊天目标准备好后建立 gRPC 长连接；断开后重连 | 同一 Runner 只开一条；gRPC 自动 retry 关闭；Runner 自己退避，见风险 R2 |
| liveChatMessages.insert / 20 | `live-chat.ts:113,121` | 有合格消息、AI 回复且达到发送间隔 | 默认最短间隔 5 秒，可配到 60 秒；队列/已见消息去重；未知发送结果不自动重发；没有全项目每日发送预算 |
| channels.list / 1 | `src/core/publishing/accounts.ts:61–69` | 发布账号名称等元数据刷新 | 成功 25 天；失败尝试间隔 30 分钟；不随 1 秒 tick 每秒请求 |

前端读取播放列表入口在 `src/app/components/broadcast-settings.tsx:49` 与 `src/app/publishing/publishing-channel-options.tsx:15`。测试脚本或历史说明的旧成本不是计费依据。

### 4.2 普通视频发布

底层 `src/core/youtube/video-api.ts:38` 在请求前向 Cloud 发布额度账本准入；该机制**只覆盖经该包装器调用的发布方法**，没有涵盖直播、聊天、授权后的频道查询与发布账号元数据查询，resumable 字节传输也不按普通方法逐片记账。

| 方法 / 单次成本 | 代码位置 | 触发与实际调度 | 防护与边界 |
| --- | --- | --- | --- |
| videos.insert / 上传桶 1 | `video-api.ts:63–64` | 开始一个 resumable upload session | 保存 session/marker 恢复，避免未知结果直接重传新视频 |
| resumable probe / chunk | `video-api.ts:70–82` | 恢复进度与传输文件字节 | 直接 fetchAuthorized；属于同一上传流程，官方未在方法表给出逐分片额外成本，不能将每片算一次 videos.insert |
| videos.list / 每批 1 | `video-api.ts:103` | 发布处理、排期、核对、完成态刷新 | Runner 按 Agent/实例/账号/频道分组，每批默认最多 50 ID |
| channels.list + playlistItems.list / 1 + 每页 1 | `video-api.ts:105–112` | marker 恢复未知上传 | 遍历 uploads playlist，无总页数与重复 token 上限 |
| thumbnails.set / 50 | `video-api.ts:116–118` | 发布流程设置封面 | 经过发布准入；不属于每次状态轮询 |
| playlists.list / 1，playlistItems.list / 1，可选 insert / 50 | `video-api.ts:121–126` | 每个选定播放列表归属检查/添加 | 已完成列表持久化；先查后添 |
| videos.list / 1 + videos.update / 50 | `video-api.ts:128–137` | finalize 元数据/公开范围/排期 | ETag 条件写；Runner 前后亦读取，可有共 3 次列表读取，属于低量重复候选 |
| videos.list / 1 + 可选 update / 50 + 确认 list / 1 | `video-api.ts:140–147` | 取消未公开视频排期 | 先查是否需改，避免覆盖已公开视频；不是后台每秒写 |

`src/core/publishing/runner.ts:335` 的 poll 分组不是 Cloud 全项目跨设备合并；跨不同频道/授权不能为了批量而混用私有凭据。默认处理态 60 秒、远期排期 1,800 秒、临近一小时排期 60 秒、已完成观察后 25 天，见 `runner.ts:409–418` 与 `src/shared/publishing.ts:45`。Executor 的短 tick 只检查到期任务，不等于每秒请求 YouTube。发布失败按任务退避 30 秒到 30 分钟（`runner.ts:185–192`），quota 失败没有独立“等到项目午夜”的总熔断；手工 reconciliation 另有约 60 秒调度。

### 4.3 前端 / Cloud / Agent 调用链

```text
桌面 runAgent / CLI main
  → 每个实例独立 snapshot reader（一次完成后再等 5 秒）
  → Executor.snapshot → Service.dashboard
  → YouTube 结果 TTL 30 秒；授权有效时：
      channels.list
      + retained broadcastId ? liveBroadcasts.list : 0
      + retained streamId ? liveStreams.list : 0

浏览器 useInstance（活跃 5 秒、后台 15 秒）
  → /api/status
  → Cloud 模式：读 Agent 最近快照，不直连 Google
  → 本地模式：Service.dashboard，同进程复用上述缓存

LiveChatRunner 每 500ms inspect
  → Service.observeChat
  → running/starting/error 且有目标时 readBroadcast
  → 与 dashboard 共用 broadcast 缓存；不是 500ms 一次上游查询
  → chat ready：一条 streamList 长连接，消息批次不重复计连接
```

源码入口：`src/agent/runner.ts:31`、CLI `src/agent/main.ts:54`、`src/agent/executor.ts:104`、`src/core/service.ts:98–126`、`src/app/use-instance.ts:73–81`、`src/app/api/status/route.ts`、`src/server/remote.ts:29`。缓存范围是单个 Service / 进程；跨设备不共享。

## 5. 问题清单、严重性与证据链

| 编号 | 严重性 / 确定程度 | 具体机制与影响 |
| --- | --- | --- |
| R1 | P0，**代码、Mock、服务器备份证实** | `service.ts:116–126` 未按 stopped/idle 过滤 YouTube dashboard 查询；`control.ts:140–171` 停止后保留 ID；Agent reader 独立运行。保留 ID 仍三读/30 秒，不开网页也继续，单路约 8,640/day |
| R2 | P0，高风险路径**Mock 复现**；昨天是否触发待验证 | `live-chat/runner.ts:214` 每个批次清零 failures，包括空批；EOF 在 218 当网络失败；`314–322` 再从 1 秒退避。连续短连接收到批次后断开，将稳定在 1 秒重连；没有生产连接时长/原因统计 |
| R3 | P0，架构缺口已证实 | 只有 `src/cloud/publishing.ts:417–431` 的发布账本；直播与聊天无同项目预算/总速率控制。projectKey 为配置标识，不自动验证实际 Google 项目归属，多个设备/应用共享额度时无法统一止损 |
| R4 | P0，可观测性缺口已证实 | 上游调用没有安全的 method/trigger/units/attempt 事件账本；Cloud 只存最近快照，LiveNest access log 关闭。无法精确定位昨天 10,000 units 去向、首次耗尽时间或预警 |
| R5 | P1，代码与 Mock 证实 | dashboard 识别 YOUTUBE_DAILY_QUOTA 后仍只缓存 30 秒；下一窗口从 channels.list 重试。聊天正确停至 PT 午夜，也不能阻止 dashboard 的后续请求。发布 quota 按普通退避，不是项目总熔断 |
| R6 | P1，容量风险已证实；现场大量发送未证实 | 默认 5 秒允许最多 12 次成功发送/分钟，240 units/min，14,400/h；前提有足够合格回复、生成成功、平台接受。当前保存成功条数很低，不当成昨天根因 |
| R7 | P1，代码与 Mock 证实 | reconnect 的 `resetAccountAiEnvironment` 无条件 refreshChatCredentials，继而 invalidate；相同凭据也可冷启动缓存和聊天流。10 次重置测试造成 30 次 dashboard 上游请求 |
| R8 | P1，代码与 Mock 证实 | 两个 Agent 入口的 snapshot reader 均在 Cloud session 成功前启动。Cloud 认证拒绝不停止已具备本地令牌的查询；复制数据根/旧进程可能隐藏耗额。已有同数据根 host 锁和 bootId 防护，不能据此推断现场有重复 Agent |
| R9 | P2，代码风险，现场未证实 | 历史恢复全量分页、重复 token 没有硬上限；超大历史或异常分页可放大请求。列表 UI 与详情准备可重复读取，未见自动循环链 |
| R10 | P2，代码证实 | 直播封面路径手工 fetch，不统一分类 quota；50-unit 写入的失败和重试缺少细粒度计量，可能误导用户重复操作 |

**未发现的情况及证据边界：**

- useInstance effect 退出清理计时器与监听器；真实 Hook 浏览器测试证实卸载和 10 次挂载切换后均无继续轮询。卸载时已发出的内部请求未全部取消是有限在途问题，不是永久定时器泄漏。
- 同 Service 的并发 dashboard 与 broadcast 在途请求合并有效。20 个读取者没有把上游扩大 20 倍；不同 Service/设备独立增长。
- LiveChatRunner 多次 start 没有开多条稳定连接；stop 会终止后续重连；显式 CHAT_QUOTA 跨配置变更仍等待 PT 午夜。
- 没有收到任何 batch 的网络错误正确指数退避：60 秒内 6 次，而不是每秒循环。
- gRPC 通用 RESOURCE_EXHAUSTED 在 `src/core/youtube/live-chat.ts:46–54` 被区分为限流，只有明确 quotaExceeded / dailyLimitExceeded 才进入日配额等待；官方也将该状态用于过快请求，不能简单把所有 code 8 都标为每日耗尽。未来须保存安全的分类与连接计数，用项目级已知 quota 信号联动熔断。
- OAuth refresh、Cloud heartbeat/长轮询/AI 配置同步不等于 Data API 请求；配置变更导致 invalidate 才可能间接多查。
- local Next 的 instrumentation 可启动本地聊天后台（`src/server/local-chat.ts:7`）；单进程注册防重。另有本地开发服务进程，但未取得有效环境及真实上游计量，**没有将它当成重复消费者的现场证据**。
- 已发布任务没有按处理态永久每分钟查询；未发现 search.list、隐蔽的第二套周期 YouTube 轮询或意外递归风暴。此结论基于当前源码，无法排除别的仓库/应用共用同一个项目。

## 6. 定量分析：理论预算与实际计数分开

### 6.1 模型前提

每日按 86,400 秒；所有实例始终授权、保留 ID、低延迟且有 reader，TTL 理想命中窗口 30 秒。实际 reader 是“请求耗时 + 5 秒”，慢网会减少稳定查询频率；控制 invalidate/进程重启会增加。以下为源码导出的持续速率，**不是服务器实测账单**，也不包含一次性开停播、授权、封面、列表、额外失败、其他应用。模型脚本：`scripts/audits/youtube-quota-model.mjs`。

### 6.2 仅状态查询：直播中或停播后保留 ID

每实例每小时：`3 × 3600 / 30 = 360 units`；每天：`3 × 86400 / 30 = 8640`。

| 实例数 | 1 小时 units | 24 小时 units | 默认 10,000 从满额耗尽时间 |
| ---: | ---: | ---: | --- |
| 1 | 360 | 8,640 | **仅此路径一天不会耗尽**；不重置的数学值 27h46m40s 没有每日运行意义 |
| 10 | 3,600 | 86,400 | 2h46m40s |
| 50 | 18,000 | 432,000 | 33m20s |
| 100 | 36,000 | 864,000 | 16m40s |

已授权但没有场次/推流 ID：只有 channels.list，约 120/h、2,880/day；1/10/50/100 路每天分别 2,880 / 28,800 / 144,000 / 288,000。无授权为 0，不按 OBS 槽位数直接乘。

假如两台各有一个有效保留 ID 的实例且共用项目并全天健康，其理论状态成本 17,280/day。但现场并未证明昨天具备这些前提。单路 8,640 后只剩 1,360，相当于 **68 次**当前成本的成功聊天发送就到 10,000，其他写操作还会进一步挤占。

### 6.3 额外聊天室风险与发送容量

| 实例数 | 默认 5 秒回复队列饱和 + 状态：units/h | 同情形 units/day | 短流每秒重连 + 状态：units/h | 同情形 units/day |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 14,760 | 354,240 | 18,360 | 440,640 |
| 10 | 147,600 | 3,542,400 | 183,600 | 4,406,400 |
| 50 | 738,000 | 17,712,000 | 918,000 | 22,032,000 |
| 100 | 1,476,000 | 35,424,000 | 1,836,000 | 44,064,000 |

发送模型：`20/5 + 3/30 = 4.1 units/s`，单路约 40m39s 耗尽，100 路约 24.4 秒。重连模型：`5/1 + 3/30 = 5.1 units/s`，单路约 32m41s，100 路约 19.6 秒。都是极端持续容量模型，不承诺平台会接受此速率；发送表没有加长连接建立时的每次 5 units。

### 6.4 正常、失败、刷新与其他业务

| 场景 | 可复核的调用量 / 预算 | 解释 |
| --- | --- | --- |
| 20 个并发页面读同 Service | 每个到期窗口仍 3 次；1/10/50/100 实例两窗口测得 6/60/300/600 次 | 没有同进程 20 倍请求放大；Cloud 页主要读取快照 |
| 同进程频繁网页刷新 | TTL 内不会重新查询；测试同一 Service 连读只 3 次 | 不能将每次 F5 算三次 Google |
| 新建 Service / Agent 重启 | 10 个全新 Service 共 30 次 | 内存缓存不持久，重复进程不是浏览器刷新 |
| 重连重置 | 相同凭据 10 次 reset + dashboard 共 30 次 | 同一进程也可因失效缓存增加调用 |
| 明确 quotaExceeded 或首个 channel 请求网络失败 | Mock 120 次尝试/h/实例；因首个请求失败，不继续 B/S 两读 | 不是 360 次；网络是否到达服务端及失败成本需监控；没有 dashboard 午夜熔断 |
| 无 batch 的聊天网络故障 | 0/1/3/7/15/31 秒，共 6 次/60 秒；持续时上限退避约 30 秒 | 若服务器接受了每次 stream 调用再报错，成本可能继续增加；不能把 Mock 端异常当实扣 |
| 先 batch 后 EOF | 含 [0,60s] 两端 61 次，稳定每秒一次 | 首尾边界解释；不能直接用 61×60 作为小时长期速率 |
| 一次全新 start，无详情，等待首次成功 | 最小路径约 11 次、11 units | 两个等待环各 120 秒/3 秒，理想最多约 40 次读取；网络抛错立即退出当前等待，不自动 retry 403 |
| 普通 stop | 常见 2–4 次 1-unit 调用，是否 transition/等待取决于状态 | 本次任务不为了测它操作真实直播 |
| 直播封面 / 每个新播放列表 | +50；列表校验每页 +1、每列表查 +1、缺失时添 +50 | 手工操作和详情准备的一次性高成本部分 |
| 同频道 100 个 processing 视频 | 默认每 60 秒 2 次 videos.list，理论 120/h、2,880/day | 实测两个到期窗口 4 次，59 秒窗口内无重复；发布账本还可能提前阻断 |
| 100 个不同频道各一个 processing | 每窗口 100 次，理论 6,000/h、144,000/day | 不能跨私有授权任意合批；这些是需求，非可保证成功的实际消费 |
| 两个已 published 视频 | 初始一批核对一次，接下来一天 0 次 | Mock 验证完成态休眠，现场下次核对为 10-31 |

## 7. 自动化验证与复现

所有新增测试均使用 Mock HTTP/端口、隔离临时存储与假时钟；没有调用真实 YouTube、使用真实直播间、OAuth consent 或发送消息。浏览器测试只打开本机合成页，内部 HTTP 也为 Mock，外部网络被阻断。

| 文件 | 数量 | 验证内容与结果 |
| --- | ---: | --- |
| `tests/youtube-quota-audit.test.ts` | 11 | 停播残留 ID 360/h；无 ID 120/h；无授权 0；多规模并发、缓存共享、失败节流、冷启动与 reset；通过 |
| `tests/youtube-quota-chat-audit.test.ts` | 5 | start 幂等、stop、短流 EOF 61 次/60 秒、无 batch 网络 6 次、quota 午夜阻断、默认 12 发/分钟；通过 |
| `tests/youtube-quota-publishing-audit.test.ts` | 4 | 50-ID 分批与 60 秒间隔、跨频道隔离、完成态一天无新读、quota 30 秒重试；通过 |
| `tests/youtube-quota-agent-audit.test.ts` | 1 | Cloud session 一直拒绝时前 12 秒仍有 0/5/10 秒三次 snapshot，停止后 reader 退出；通过 |
| `tests/youtube-quota-ui-audit.mjs` | 5 个浏览器场景 | 活跃 5 秒、后台 15 秒、卸载/重挂载无泄漏、20 Hook 内部请求计数；通过 |
| 离线模型脚本 | 5 场景 × 4 规模 | 输出容量表，未读取令牌、未请求任何 API |

复现：

```powershell
npx vitest run tests/youtube-quota-audit.test.ts tests/youtube-quota-chat-audit.test.ts tests/youtube-quota-publishing-audit.test.ts tests/youtube-quota-agent-audit.test.ts
$env:QUOTA_AUDIT_BROWSER_CHANNEL = "msedge"
node tests/youtube-quota-ui-audit.mjs
node scripts/audits/youtube-quota-model.mjs
npm run verify
```

新增 Vitest 共 **21 项**，浏览器 5 场景。**`npm run verify` 完整通过：typecheck、ESLint、124 个测试文件的 1,183 项测试、8 项部署测试、Next 生产构建、Agent 构建全部成功。**Vitest 另有既有 configLoader 未来版本兼容提示，不影响通过。初次复用跨盘 node_modules 的 junction 导致构建工具拒绝，改用工作树自身的实体依赖后完整重跑通过；未修改业务来绕过构建。Mock 不能证明昨天实际发生过短流，也不是开播、OAuth、视频连续流畅性的真实集成验收。

## 8. 修复方案：具体改什么、减少多少、风险是什么

本节为待实施设计，没有偷偷修改业务。建议优先次序：**立即止损与计量 → 生命周期查询 → 重连缺陷 → 统一项目预算 → 扩容验证。**

| 对应问题 / 修改点 | 预期减少与效果 | 风险与应有测试 |
| --- | --- | --- |
| R1：将 OBS 本地 5 秒采样与平台查询拆开；stopped/complete 不再定期 B/S 查询 | 仅跳过 B/S：8,640→2,880/day，减少 5,760/实例/day；频道元数据改为授权事件/合理缓存后近乎消除停播常驻消费 | 未知结果/OBS 仍在推流不能误判已结束；显式核对仍保留且预算准入 |
| R1：频道身份绑定授权结果，标题元数据按独立较长周期刷新；健康直播平台巡检按预算调节 | channels.list 2,880/day 可降至约 1/day 或事件驱动；例如两次平台检查/小时×100 路×24h=4,800/day（每次一个请求时） | 例子是预算设计，是否足够及时需业务 SLA 决定；若每次同时查场次和 ingest，成本再乘 2 |
| R2：重连失败计数只在连接持续稳定后重置，不能每个空批/短批清零；EOF 也退避、加 jitter | 故障长连接从约 3,600 connections/h 降至长故障约 120/h；减少约 96.7%，但单靠 30 秒退避仍可能高，必须配合预算/熔断 | 空 batch 本身合法，不能误判；测短批、长连接正常批、EOF、quota、取消、游标恢复，避免丢消息或重复回复 |
| R3/R5：持久化项目级多桶准入、并发、每日预算与 circuit breaker | quota 后非必要尝试停至 PT 午夜；避免各 Agent 独立试探；把计划成本限制在可用预算内 | 授权/限流/网络错误区分；不要因 Google 查询失败自动中断已有 OBS 推流；重置处理 DST |
| R6：发送独立 unit 预算、按项目/频道分配、有限队列与明确停用反馈 | 每 1,000 通用 units 最多预算 50 条成功发送，尚需预留连接和查询；100 路不再各自默认 5 秒无限竞争 | 不能承诺持续实时自动回复；预算耗尽可降级为界面草稿，避免积压后补发过期消息 |
| R7：只在凭据/授权主体/真实配置变化时 invalidate 与重启流 | 相同环境重连测试目标 10 次 reset 不再额外 30 次读取；健康流不因控制链路抖动重复建立 | 真实换号必须立刻失效，防止旧频道凭据/缓存串用 |
| R8：Cloud 注册成功前只读本地 OBS；非必要平台查询需要有效所有权/租约 | 避免被拒绝或遗留的 Agent 在后台继续占额度；跨数据根启动也能被识别 | 设计离线宽限与持久租约，保护网络短暂中断后的合法直播自主运行；两个入口行为一致 |
| R9：所有分页统一 visited-token、最大页数/总时限/预算 | 异常 token 不再无界循环；大历史有明确上限与可恢复提示 | 达到上限应返回“未确认”，绝不能误判不存在而重复 create |
| R10：封面等直接 fetch 统一错误分类与计量 | 50-unit 调用可追溯，quota 时停止无意义重试；节省量由实际用户重试次数决定 | 不改变未知结果的安全恢复语义；不自动重发写操作 |
| R4：新增安全调用事件、项目聚合、告警与诊断导出 | **不直接省 units，但让每笔计划成本有去向，能检测重连/重试/残留轮询并验证节省** | 异步缓冲有界、持久落盘、去重、采样策略明确；关键计数不能因采样丢失；不记录敏感正文 |

OBS WebSocket / Agent 可提供推流是否活跃、丢帧、编码/渲染负载、码率、场景、媒体、进程与控制进度。YouTube 平台是否接收、转码健康、场次 lifecycle、真实 liveChatId 与授权归属仍需必要平台请求或其他官方信号，不能用“OBS 正在推流”冒充“YouTube 已直播”。

## 9. 日志、看板与 Google Cloud 交叉核对方案

### 9.1 应记录什么

在每个真实网络边界统一记安全结构化事件，而不是打印 fetch URL、headers 或原始 error：

- 时间：UTC、单调耗时；projectAlias、设备/实例别名、授权主体不可逆标识。
- 方法与配额：如 liveChatMessages.streamList、REST/gRPC、配额桶、文档版本对应的预计成本。
- 原因与关联：dashboard / ingest-wait / reconnect / send / publish / recovery / auth-finish、traceId、逻辑操作 ID、attempt、cache hit/coalesced 结果。
- 结果：开始/结束、HTTP 状态或 gRPC 状态、白名单业务错误码、耗时、结果确定性。流连接另记持续时长、批次数、消息数量、断开原因；**不记消息正文**。
- 调度：nextAttempt、退避秒数、breaker 开闭/到期、预算准入/拒绝；同时保存计数器，避免日志采样导致估算失真。

严禁令牌、OAuth code、client secret、OBS 密码、Stream Key、完整 URL 查询、原始请求/异常、聊天文本。日志出错不得阻塞推流；有界写队列、轮转、保留策略、磁盘满告警及丢日志计数。Cloud 汇总只接收计量与安全事件，YouTube token 仍归 Agent。

建议看板按 PT 配额日显示：各方法调用/预计 units、失败码、设备/功能排行、stream 建连率与时长、缓存命中、预算剩余及按当前速率预测的耗尽时间。超过预算阈值、短连接异常或 quota 后仍调用时告警。**验收标准：从某一分钟的 units 异常可以一路追到设备、触发操作及重试原因；模拟 quota 后能证明所有相关业务停止非必要调用。**

### 9.2 如何补齐昨天精确账单

需要项目具有查看权限的用户或管理员在 Google Cloud 提供以下**脱敏指标导出/截图**；不需要、也不应提供密钥：

1. 先确认主电脑 OAuth client 对应的实际 Google Cloud 项目，核对另一 Agent 与其他应用是否相同；记录默认或获批额度、通用桶/Video Uploads/Search 的实际限制。
2. 在 YouTube Data API v3 的 Metrics / Quotas & System Limits 查看至少 UTC **10-17 07:00 至 10-20 07:00**，同时按 PT 配额日分窗；在异常区段细化到分钟。需要每日 usage/limit、首次耗尽时刻和每方法 requests/error 曲线（若界面支持）。
3. 若该 API 提供 Cloud Monitoring 指标，查看 `serviceruntime.googleapis.com/api/request_count` 的 service、method（以实际 descriptor/resource labels 为准）、protocol、response_code、grpc_status_code；重点关注 streamList 连接、channels/list、liveBroadcasts/list、liveStreams/list、聊天 insert、thumbnail/playlist 写入。不能只筛 REST 403，gRPC quota 可表现为 RESOURCE_EXHAUSTED。
4. 若项目暴露 consumer_quota 指标，再查 `quota/allocation/usage`、`quota/limit` 与实际 quota_metric/limit_name；不是所有服务/桶都承诺有同样的 descriptor。配额 units 不能直接用 requests 总数替代。
5. 按 method 的正确成本与失败边界估算，再与官方日 usage 对账；确认其他 OAuth clients/应用的消费。Cloud 侧通常不能直接按本应用 instanceId 区分，未来必须靠 Agent 计量关联。
6. 标明指标采样/显示延迟、缺失维度、历史保留期和实际时区；没有指标不能把“看不到”解释成“没调用”。

指标字段与可用性以 [Google API Monitoring 文档](https://docs.cloud.google.com/apis/docs/monitoring) 和 [Quota metrics 文档](https://docs.cloud.google.com/monitoring/alerts/using-quota-metrics) 为准。Monitoring 请求指标通常有采样与可见延迟，截图时间不等于故障发生时间。当前未取得该项目的控制台历史数据，因此报告不能给出昨天精确的 per-method 消费占比。

## 10. 长期支持 100+ 路的架构建议

1. **Agent 仍负责令牌与实际操作。**保留本地 OBS 高频状态与自主恢复，Cloud 管身份、所有权、配送和项目级计量/预算，不迁移成 Cloud FFmpeg 或通用 Job 平台。
2. **平台状态按语义维护。**频道身份复用授权结果；场次准备/启动短时确认；稳定直播低频巡检；已结束场次停止后台查询；未知结果有明确有限核对窗口，不能永远维持高频 error 状态。
3. **缓存只在相同授权主体和可共享资源边界复用。**同实例聊天与 dashboard 继续合并。多页面读取 Cloud 快照；同一频道的发布视频合批。跨频道私有结果不为了省额度混合。
4. **一个真实 Google 项目一份持久预算。**映射实际 OAuth client 的项目配置；区分通用、上传、搜索桶；Cloud 发有界额度租约，Agent 离线额度受限。逻辑操作幂等 receipt、并发预留、未知结果保守记账、PT 午夜重置、按功能预留配额。不要把发布项目字符串当成全应用真实账本。
5. **优先级与降级明确。**有限额度优先必要的开停播结果核对，再是用户显式查询和巡检，聊天/批量元数据可停止或延后；即使额度耗尽也不能自动停掉正在正常传输的 OBS。
6. **以预算推导巡检 SLA。**100 路仅每小时两次单方法巡检已需 4,800/day，剩余空间要容纳授权、开停播、聊天流连接和发布。100 个稳定 streamList 首次建连就预算 500；消息发送每条 20。需求超出 10,000 时，需量化业务 SLA 并申请正式配额提升，参考 [YouTube Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)。不能用新建多个项目规避配额限制，参见 [官方开发者政策指南](https://developers.google.com/youtube/terms/developer-policies-guide)。
7. **扩容先离线故障注入。**100/500 实例运行跨 PT 午夜与 DST；模拟 Cloud 断线、Agent 多进程/重连、短流 EOF、quota、429、超时未知结果、分页 token 异常；断言全项目预算、请求上限、所有权和无重复写。再由用户授权做少量真实调用与控制台对账，不能用真实直播间压测消耗额度。

本轮结论：已经找到并验证足以显著浪费额度的具体路径，也实际检查了昨天服务器备份；**尚未取得能唯一解释昨天全部项目消费的历史调用计量**。修复时必须同时补上安全计量，否则即使修改轮询，下一次仍难判断是谁、何时、为何耗尽。
