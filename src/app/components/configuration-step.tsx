/** 配置表单的顺序标题；数字表达操作顺序，使用原生标题和字段组保留语义。 */
import type { ReactNode } from "react";

/** 复用同一编号样式，父级可将标题放入 legend 或 heading。 */
export function ConfigurationStepTitle({ number, children }: { number: number; children: ReactNode }) {
  return <><span className="configuration-step-number">{number}</span>{children}</>;
}
