/** 已认证工作区的公开成员身份；独立上下文避免上传组件依赖账户设置界面。 */
"use client";
import { createContext } from "react";
export const WorkspaceUserContext = createContext<{ username: string; role: "admin" | "customer" } | undefined>(undefined);
