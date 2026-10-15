/** 直播与发布共用已登录布局；路由改变时不重建会话、上传与编辑状态。 */
import type { ReactNode } from "react";
import AccessGate from "../access-gate";
import Workbench from "../components/workbench";
/** 路由页仅提供元数据，业务视图由常驻工作区按首次访问加载。 */
export default function WorkbenchLayout({ children }: { children: ReactNode }) { return <AccessGate><Workbench />{children}</AccessGate>; }
