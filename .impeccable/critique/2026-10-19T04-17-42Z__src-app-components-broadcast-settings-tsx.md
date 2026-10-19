---
target: AI 观众互动：间距混乱、功能混放与说明过多
total_score: 22
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\LiangYS\\.codex\\worktrees\\livepilot-web\\LivePilot-v2\\src\\app\\components\\broadcast-settings.tsx"
target_fingerprint: "sha256:eaad90429a8382ea8fb0089fd0a17f93769e8281264525742c949398a649fd67"
target_path: "C:\\Users\\LiangYS\\.codex\\worktrees\\livepilot-web\\LivePilot-v2\\src\\app\\components\\broadcast-settings.tsx"
timestamp: 2026-10-19T04-17-42Z
slug: src-app-components-broadcast-settings-tsx
---
<!-- 文件用途：归档网页端 AI 观众互动区域的独立设计评审、页面测量和改进方向，后续问题状态以 docs/网页端问题记录.md 为准。 -->
# AI 观众互动区域诊断

Method: dual-agent (A: /root/ai_interaction_design · B: /root/ai_interaction_evidence)

用户已明确优先级：间距混乱、功能混放、废话过多。诊断基线为 main 提交 1fabef8，目标为 src/app/components/broadcast-settings.tsx 的 AI 观众互动区域。本轮只修改诊断文档，未修改产品界面。

## 设计判断

「观众留言、人设、试聊」符合直播产品，但当前布局把配置表单与调试工具直接接在一起。应先确立功能分组，再让间距表达组内和组间关系，并把解释放到对应动作发生时。

## 启发式评分

人工评价为 22/40，表示需明显改进；不是性能或用户实验分数。浏览器只检查桌面合成状态，未验证的错误与辅助技术行为仅按源码评价。

| 项目 | 分数（0–4） | 依据 |
| --- | --- | --- |
| 状态可见性 | 2 | 人设可见，但关闭时失去选择入口；真实服务异步状态未验 |
| 用户语言 | 3 | 主要标签自然，部分例句偏内部测试 |
| 用户控制 | 2 | 可关闭与清空，源码中的生成等待没有取消入口 |
| 一致性 | 3 | 控件一致，但局部间距无统一规律 |
| 错误预防 | 3 | 空输入限制、长度约束与额度提醒存在；真实失败未验 |
| 识别优于回忆 | 2 | 关闭态提示切换人设却没有对应入口 |
| 效率 | 2 | 有例句、Enter 和单句比较，但操作被纵向内容拉开 |
| 简约 | 1 | 说明过多、功能混放、拥挤和大空白并存 |
| 错误恢复 | 2 | 源码保留失败输入；真实错误恢复未验 |
| 帮助 | 2 | 边界说明完整，但重复且出现太早 |
| 合计 | 22/40 | 尚可，需要明显改进 |

## 优先问题

### P1 功能分组与间距没有建立统一关系

说明与示例、输入框与操作按钮间实测均为 0 像素；标签到输入框约 1.2 像素，另一处分组间距却叠到 42 像素。全局 p margin 清零、预览内部未设分组 gap、表单 gap 与额外 margin 叠加、空 ol 保留默认 margin，共同造成这一结果。

本场自动回复与可选试聊顺序混放。关闭开关时，人设编辑消失而试聊一直展开。关闭时仍可试聊是有效能力，不应作为功能错误；应把两种任务的关系和人设入口表达清楚。

建议按「开关与人设」「可选试聊」「结果」组织，保持组内紧凑、组间有固定分隔。试聊按需展开，空结果不占位，关闭自动回复后仍允许主动试聊和调整人设。对应 Impeccable layout、distill。

### P1 说明先于操作、重复且没有按状态披露

本地初始试聊态在没有任何回复前就展示三段合计 124 字的说明与 7 个例句；比较按钮尚不存在，比较机制却已经出现。标题与段落重复解释不会发送到直播间。

建议默认只保留必要边界：「试聊不发送到直播间，会消耗 AI 额度」。当前人设用短状态，比较说明等有结果和对应动作时再显示，服务条件在不可用时给具体原因；首层只留少量常用例句。对应 Impeccable clarify。

## 证据

| 本地页面状态 | 自动回复关闭 | 自动回复开启 |
| --- | --- | --- |
| AI 区域高度 | 523.2 px | 974.8 px |
| 配置字段高度 | 44 px | 495.6 px |
| 空试聊区高度 | 358.4 px | 358.4 px |

测量视口为 1280 × 720 CSS px，DPR 2.5，AI 区域宽 935.2 px；没有观察到该尺寸横向溢出。两个评审各用独立新建浏览器标签；A 完成后才向汇总者披露 B 的检测结果。

三个 TSX 目标的 CLI detector 只运行一次，退出码 0，JSON []，0 项发现，没有可判定的误报。这不能覆盖 CSS 布局、任务语义与交互层级。

源代码定位：globals.css:46、261；live-chat-fields.css:9、14、30；live-chat-preview.tsx:32–38；broadcast-settings.tsx:88、100。

## 应保留的基础

- 明确试聊不会发送到直播间，且调用需要额度。
- 例句只填入输入框，用户主动点击才生成。
- 结果保留人设和设置快照，支持比较同一句话。

## 用户视角与较小问题

首次使用者容易把关闭的自动回复和仍展开的试聊误解为同一个未完成任务；熟练用户需要在人设与结果间反复滚动；键盘用户会遇到空列表的 tabIndex=0 焦点。未做屏幕阅读器验收，不据此宣称读屏失败。

「what is 谈何」适合模型边界测试，作为常驻例句则不易理解。比较和清空入口应在已有结果时按需出现，不能靠新增说明补偿结构问题。

Questions skipped: 2 Priority Issues; user has already specified grouping, spacing and concise copy, and requested a Markdown issue log.
