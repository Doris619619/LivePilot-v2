/** 工作区生命周期与导航插槽；仅保留公开 UI 状态，不缓存身份凭据。 */
"use client";
import { createContext, useContext, type Dispatch, type SetStateAction } from "react";

export const WorkbenchViewContext = createContext<{ active: boolean; navigation: HTMLElement | null } | undefined>(undefined);
export type TransferSummary = { filename: string; label: string; percent?: number };
export const WorkbenchTransferContext = createContext<Dispatch<SetStateAction<TransferSummary | undefined>> | undefined>(undefined);

/** 独立预览、桌面与单组件测试默认可见，网页工作区才参与休眠。 */
export function useWorkbenchActive() { return useContext(WorkbenchViewContext)?.active ?? true; }
