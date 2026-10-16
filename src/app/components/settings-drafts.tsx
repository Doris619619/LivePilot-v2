/** 设置窗口内的未保存标记；仅驻留内存，关闭窗口后随表单一起销毁。 */
"use client";
import { createContext, useContext, useEffect } from "react";

export const SettingsDraftContext = createContext<((id: string, dirty: boolean) => void) | undefined>(undefined);

/** 表单报告是否有未保存修改，卸载时移除标记；工作台中的同款表单不受影响。 */
export function useSettingsDraft(id: string, dirty: boolean) {
  const report = useContext(SettingsDraftContext);
  useEffect(() => { report?.(id, dirty); return () => report?.(id, false); }, [report, id, dirty]);
}
