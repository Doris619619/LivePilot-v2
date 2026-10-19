/** 文件用途：一次展开一个 OBS 配置步骤，隐藏时保留面板与其中的输入状态。 */
"use client";
import { useState, type ReactNode } from "react";
import { ChevronDownIcon } from "../../src/app/components/icons";
import styles from "./obs-setup-steps.module.css";

export type ObsSetupStep = { label: string; complete: boolean; pending: string; status?: { text: string; tone: "running" | "error" }; content: ReactNode };

/** 首次选未完成项，轮询不打断编辑；展开时省略通用完成标签，具体结果由内容说明。 */
export default function ObsSetupSteps({ instanceId, steps }: { instanceId: string; steps: ObsSetupStep[] }) {
  const [selected, setSelected] = useState(() => {
    const next = steps.findIndex(step => !step.complete);
    return next === -1 ? 2 : next;
  });

  /** 原生按钮支持键盘操作；只改变可见性，不卸载旧面板或将焦点移入隐藏内容。 */
  function selectStep(index: number) {
    setSelected(index);
  }

  return <ol className={styles.steps} aria-label="OBS 配置步骤">
    {steps.map((step, index) => {
      const expanded = selected === index;
      const triggerId = `obs-step-${index + 1}-${instanceId}`;
      const panelId = `obs-step-panel-${index + 1}-${instanceId}`;
      const status = step.status?.text || (step.complete ? "已完成" : step.pending);
      return <li key={step.label} className={styles.step} data-step-state={step.status?.tone || (step.complete ? "complete" : "pending")}>
        <h4 className={styles.heading}><button type="button" id={triggerId} className={styles.trigger} aria-expanded={expanded} aria-controls={panelId} aria-disabled={expanded || undefined} onClick={() => selectStep(index)}>
          <span className={styles.number} aria-hidden="true">{index + 1}</span><span className={styles.title}>{step.label}</span><span className={styles.status} data-step-header-status hidden={expanded && step.complete && !step.status}>{status}</span><ChevronDownIcon className={styles.chevron} aria-hidden="true" />
        </button></h4>
        <div id={panelId} className={styles.panel} role="region" aria-labelledby={triggerId} data-obs-step-panel={index + 1} hidden={!expanded}>{step.content}</div>
      </li>;
    })}
  </ol>;
}
