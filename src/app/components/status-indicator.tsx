/* 文件用途：LiveNest 专属清晰步骤指示器与紧凑状态徽标（参考现代企业级控制台风格）。 */

import React from "react";

export type StatusType = "live" | "ready" | "busy" | "standby" | "error" | "stale" | "offline";

export interface StatusBadgeProps {
  status: StatusType;
  label: string;
}

/**
 * 渲染极简克制的状态药丸徽标。
 */
export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="pill-dot" />
      <span>{label}</span>
    </span>
  );
}

export interface StepSectionProps {
  step: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * 渲染 1, 2, 3, 4 结构化序号卡片分区。
 */
export function StepSection({ step, title, action, children }: StepSectionProps) {
  return (
    <div className="step-section">
      <div className="step-header">
        <div className="step-title-group">
          <span className="step-number">{step}</span>
          <h3 className="step-title">{title}</h3>
        </div>
        {action && <div className="step-action">{action}</div>}
      </div>
      <div className="step-body">{children}</div>
    </div>
  );
}
