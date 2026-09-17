/* 文件用途：为 LiveNest 广播控制台提供高质感状态胶囊、呼吸指示灯与连接状态标识。 */

import React from "react";

export type StatusType = "live" | "ready" | "busy" | "standby" | "error" | "stale" | "offline";

export interface StatusIndicatorProps {
  /** 状态类型 */
  status: StatusType;
  /** 状态显示文字 */
  label: string;
  /** 是否带有外框胶囊样式 */
  pill?: boolean;
  /** 补充类名 */
  className?: string;
}

/**
 * 渲染 LiveNest 专用状态指示器，包含呼吸光环与状态文字。
 *
 * @param props 状态属性
 * @returns 状态指示器 React 元素
 */
export function StatusIndicator({ status, label, pill = true, className = "" }: StatusIndicatorProps) {
  return (
    <span className={`status-badge status-${status} ${pill ? "badge-pill" : "badge-inline"} ${className}`}>
      <span className="status-dot-ring">
        <span className="status-dot" />
        {status === "live" && <span className="status-ping" />}
      </span>
      <span className="status-text">{label}</span>
    </span>
  );
}

/**
 * 管道连接微指示器（OBS / YouTube）。
 *
 * @param props 连接属性
 * @returns 连接徽标
 */
export function ConnectionNode({
  title,
  connected,
  label,
  icon,
}: {
  title: string;
  connected: boolean;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={`connection-node ${connected ? "is-connected" : "is-disconnected"}`}>
      <div className="connection-icon-wrap">{icon}</div>
      <div className="connection-meta">
        <span className="connection-title">{title}</span>
        <div className="connection-state">
          <span className={`node-dot ${connected ? "online" : "offline"}`} />
          <span className="node-label">{label}</span>
        </div>
      </div>
    </div>
  );
}
