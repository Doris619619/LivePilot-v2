/* 文件用途：LiveNest 专属状态标签组件，提供严谨克制的高级浅色状态标识。 */

import React from "react";

export type StatusType = "live" | "ready" | "busy" | "standby" | "error" | "stale" | "offline";

export interface StatusBadgeProps {
  status: StatusType;
  label: string;
}

/**
 * 渲染极简高级状态胶囊。
 */
export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="pill-dot" />
      <span>{label}</span>
    </span>
  );
}
