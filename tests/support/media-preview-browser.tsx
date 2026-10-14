/** 隔离验收页挂载正式计划预览组件，所有媒体请求走真实 HTTP 和独立 Agent。 */
import { createRoot } from "react-dom/client";
import PlanMediaPreview from "../../src/app/publishing/plan-media-preview";
import type { PublishingPlan } from "../../src/shared/publishing";
import "../../src/app/components/ui/ui.css";
import "../../src/app/workspace-refresh.css";
declare global { interface Window { previewPlan: PublishingPlan } }
createRoot(document.getElementById("root")!).render(<main><h1>发布前预览 · 隔离 Agent 验收</h1><p>标题、频道、封面与素材取自已配置的发布计划。此页只读取合成测试文件，不创建上传或开播。</p><PlanMediaPreview plan={window.previewPlan} channel="隔离测试频道" /></main>);
