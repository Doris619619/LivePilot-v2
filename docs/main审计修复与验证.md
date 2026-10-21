<!-- 文件用途：逐项记录2026-10-21 main审计的确认结果、修复契约、验证入口和真实集成边界。 -->
# main 审计修复与验证

## 1. 基准与范围

基准为 `9493130240d6984fb8e01e66fb5ba84a81711a43`。本轮核对用户提供的《LivePilot-v2_main_全面审计_2026-10-21》，覆盖 M01–M13、L01–L02。报告中的建议是待验证材料，修复依据为当前源码与隔离回归结果。

原 `D:\Repo\LivePilot-v2` 目录中的直播质量诊断修改保留，本轮在独立工作树实施。预算默认值、成本与后台轮询节奏保持，修复准入遗漏的业务屏障、证据呈现及政策并发保存。交付范围为 PR，不执行合并、安装包发布、部署或真实外部操作。

## 2. 逐项确认与恢复契约

| 编号 | 确认结果与修复行为 | 主要回归入口 |
| --- | --- | --- |
| M01 | 原登录代际、用户名、设备ID及token已核验时，临时网络失败仍返回最新本机只读快照；设备配置和本机OBS两页保留受限停止入口。403、换号、登录失效和外来推流不降级 | `desktop-binding.test.ts`、`desktop-recovery-ui.smoke.mjs` |
| M02 | 心跳新鲜度与平台核对时间分开；超过五分钟或缺失时间不再称为当前直播确认。显示真实时间、年龄和下次后台核对安排。显式核对跳过平台缓存，逐HTTP交互准入；旧Agent明确提示升级 | `youtube-quota-audit.test.ts`、`broadcast-runtime.test.ts`、`remote-routes.test.ts`、`broadcast-controls-ui.smoke.mjs` |
| M03 | 广播和推流对象创建只在可信 `not-sent` 错误时撤销该次意图；Google请求未知仍保留原标题查重。推流对象未发送不丢弃已创建的广播 | `control.test.ts` |
| M04 | 新建上传与批次删除共享发布事务屏障，固定 `publishing → budget` 锁序；删除/暂停/取消后的旧执行器不得新建上传，原视频读取、探测及撤销排期仍可进行 | `publishing-control-recovery.test.ts` |
| M05 | 授权恢复使用Cloud生成的凭据代次和OAuth事务代际；旧报告不能把新授权再次停用，新真实授权失败仍有效。核对/暂停/取消清理历史错误事件，保留原视频 | `publishing-control-recovery.test.ts`、`youtube-recovery-integration.test.ts` |
| M06 | 未交付的发布设置修复标记继承到后续继续、核对和取消修订，仍只在原视频上执行受限修复 | `publishing-control-recovery.test.ts` |
| M07 | 上传、恢复及取消共用操作互斥与会话代际；持有上传记录时从 `record.kind` 派生格式，迟到响应不改写新会话 | `upload-recovery-ui.smoke.mjs` |
| M08 | 退役错误后核对原身份库存：明确未提交恢复原实例并解除维护，未知保留待确认，已退休不复活。关联账号和未完成工作保护保留 | `desktop-candidates.test.ts` |
| M09 | 退役事务记录原agentId；解绑及身份变化归档旧事务，不让新设备提交旧退役。孤立旧版事务只在明确空新库存的迁移边界收敛 | `desktop-candidates.test.ts` |
| M10 | 持久退休墓碑后的频道清理可幂等重入，补清理精确目标的binding/claim后才视为完成；库存鉴权和活跃实例保护保留 | `instance-inventory.test.ts` |
| M11 | 原数据定位先写无凭据提交日志，再写原根密文和locator；阶段失败可重启重入或回搬恢复。原账户、rootId、原位置副本及活锁核验保留，不创建新身份 | `desktop-data-root.test.ts` |
| M12 | Summary携带持久政策修订，政策替换在事务内CAS；缺失/过期版本返回409。清洁草稿同步刷新，已编辑草稿保留并提示冲突，可显式放弃重载 | `youtube-usage-admin-recovery.test.ts`、`youtube-policy-recovery-ui.smoke.mjs` |
| M13 | 普通查询绑定发起时的revision、desired和videoId；已接受新取消后，迟到成功或失败不得覆盖取消的执行时间 | `publishing-control-recovery.test.ts` |
| L01 | 明细查询、CSV和JSONL共用14天保留期边界及expired标记，区分过期与无匹配，支持PT配额日、显式范围及DST；90天汇总保留 | `youtube-usage-admin-recovery.test.ts` |
| L02 | CSV保留count与droppedEvents，页面说明合并次数，JSONL/CSV可以核对同一批缓存和拦截决策 | `youtube-usage-admin-recovery.test.ts`、`youtube-policy-recovery-ui.smoke.mjs` |

人工核对另覆盖一次交叉审计发现的竞态：平台HTTP在途时，其他窗口开始停止或已完成控制，Service返回前再次核验控制代际和关键状态，拒绝旧结果；人工核对末尾重读OBS。RPC结果携带Agent观测时间，校验实例与时效，Cloud不重新盖当前时间。前端不会用迟到心跳覆盖同场较新的平台证据，真正的新错误与新场次仍可更新。

## 3. 协议与兼容

- 人工核对采用新的只读 `broadcast-read` 任务，只有快照声明 `youtubeRefresh` 才投递；普通GET与心跳不触发新平台请求。HTTP POST仍要求成员会话、设备归属及同源写入标记，Agent保留清理屏障，结果剔除非白名单字段。
- 发布授权代次通过新能力协商提供。旧Cloud降级不丢既有配额与恢复能力；旧Agent首次授权保持兼容，需要代次保护的恢复明确提示升级。新增恢复不以删除授权或原视频为前提。
- 已发出的旧OAuth请求仍可能在本机产生部分落盘；末尾写入或Cloud最终确认失败时，Cloud保持需要重新授权，不声称已恢复，通过新的授权事务收敛。已启用代次保护的账号降级旧Agent会明确拒绝新普通调用，原清理撤销例外保留。
- 管理员全量政策替换需携带 `policyRevision`。旧账本从0开始；旧客户端不能以无版本整份表单覆盖新政策。单独提交当日用量基线保持原语义。
- Cloud与Agent应配套更新。源码修复和模拟检查不代表已部署，也不代表客户设备已升级。

## 4. 验证入口与实际边界

本轮定向回归覆盖真实Control/Service/Cloud/RPC/Runner、隔离文件系统及真实React/Edge；OBS、Google、桌面桥接与媒体传输服务均使用合成边界，意外外部请求被拒绝。专项日志保留在工作树 `.data`，不提交合成凭据或原始外部请求。

本轮 `npm run verify` 退出0：143个常规文件／1,455项与1个原生锁文件／14项全部通过，合计144个文件／1,469项；8项部署测试、类型、ESLint、Next.js及Agent构建全部通过。桌面主进程编译和静态renderer通过。最终仅另修正浏览器脚本的通过统计文案为11种状态，并通过该文件ESLint。

真实React/Edge验证：网页390／780／1440像素 × 11种状态通过，包含30分钟前的平台证据、一次显式POST核对及既有恢复入口，无页面错误或横向溢出；桌面两种宽度覆盖9个恢复/权限场景。上传竞态、双标签政策冲突及原数据台14场景通过；所有外部服务为合成响应，预览进程已退出。

合成界面材料（均未连接真实设备或平台）：

- [平台旧证据与人工核对](images/main-audit/synthetic-platform-cache.png)
- [临时断网时的受限本机停止](images/main-audit/synthetic-offline-stop.png)
- [移动宽度的过期明细说明](images/main-audit/synthetic-expired-mobile.png)

未进行真实Google OAuth同意、OBS开停播、YouTube上传/公开、Windows真实盘符故障、客户升级或长期运行验收。未发布安装包、未部署，PR创建后即交付。
