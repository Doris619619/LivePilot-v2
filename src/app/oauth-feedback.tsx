/** 在原实例显示授权结果，刷新和登录跳转只读取结果引用，不重放授权。 */
"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, requestProblem } from "./client-request";
import type { InstanceDescriptor } from "../shared/types";
import type { OAuthResult } from "../server/oauth-result";
import ProblemCard from "./components/problem-card";
const ResultContext=createContext<{result?:OAuthResult;refresh:()=>void}>({refresh:()=>{}});
/** 工作台共享一次读取；不会为每个 OBS 重复请求或跨账号缓存。 */
export function OAuthFeedbackProvider({children}:{children:ReactNode}){
 const [result,setResult]=useState<OAuthResult>();const [retry,setRetry]=useState(0);
 useEffect(()=>{const id=new URLSearchParams(location.search).get("oauthResult");if(!id)return;let active=true;void api<OAuthResult>("/api/youtube/result?id="+encodeURIComponent(id)).then(r=>{if(active)setResult(r);},e=>{if(active)setResult({target:{},status:"failed",problem:requestProblem(e)});});return()=>{active=false;};},[retry]);
 return <ResultContext.Provider value={{result,refresh:()=>setRetry(v=>v+1)}}>{children}</ResultContext.Provider>;
}
/** 只有匹配目标的卡片展示结果；无目标错误由工作台展示。 */
export default function OAuthFeedback({instance,available}:{instance?:InstanceDescriptor;available?:InstanceDescriptor[]}){
 const {result,refresh}=useContext(ResultContext);
 if(!result)return null;
 if(instance ? result.target.instanceId!==instance.id || result.target.agentId!==instance.agentId : !!result.target.instanceId && (!available || available.some(i=>i.id===result.target.instanceId&&i.agentId===result.target.agentId)))return null;
 if(!instance && result.target.instanceId && available)return <p role="status">原实例的频道授权结果已返回，但该实例当前不在此工作台。请核对设备筛选和当前账号权限后重新读取列表。</p>;
 if(result.problem)return <ProblemCard problem={result.problem} objectName={instance?.name} onRefresh={refresh}/>;
 return <p className="instance-feedback" role="status">{instance?.name} · {result.status==="cancelled"?"本次频道授权已取消，原授权保留。":"频道授权已完成，正在刷新频道状态。"}</p>;
}
