/** 故障契约、HTTP 身份边界和新旧 Agent 心跳的模拟回归。 */
import { afterEach, expect, it, vi } from "vitest";
import { makeProblem, problemSchema, problemSummary, guidance } from "../src/shared/problems";
import { AppError, problemFor } from "../src/core/errors";
import { failed } from "../src/server/http";
import { heartbeatFeedback, legacyFeedback } from "../src/agent/feedback";
import type { Worker } from "../src/agent/worker";
import { api, setRequestMember } from "../src/app/client-request";
afterEach(()=>{setRequestMember();vi.unstubAllGlobals();});
it("validates optional metadata and rejects executable actions or secret context",()=>{
 const p=makeProblem("OBS_READ","安全说明",{stage:undefined,target:{instanceId:"obs_b"}});
 expect(problemSchema.safeParse(p).success).toBe(true);
 expect(problemSchema.safeParse({...p,actions:["stop"]}).success).toBe(false);
 expect(problemSchema.safeParse({...p,context:{password:"SECRET"}}).success).toBe(false);
 expect(problemSummary({...p,message:"SECRET"})).not.toContain("SECRET");
 expect(guidance(p).steps.join()).not.toContain("停止");
 expect(problemFor(Object.assign(new Error("C:/private SECRET"),{code:"ENOSPC"})).code).toBe("STORAGE_SPACE");
 expect(JSON.stringify(problemFor(new Error("SECRET")))).not.toContain("SECRET");
});
it("keeps a primary phase when optional metadata is absent",()=>{
 const p=makeProblem("DATA","复制失败",{stage:"复制数据",outcome:"rejected"});
 expect(problemFor(new AppError("DATA",p.message,400,p),{stage:undefined})).toMatchObject({stage:"复制数据",outcome:"rejected"});
});
it("retains HTTP error compatibility without treating channel credentials as customer login",async()=>{
 const response=failed(new AppError("YOUTUBE_AUTH","频道授权失效",401));
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:"频道授权失效",problem:{version:1,code:"YOUTUBE_AUTH"}});
 expect(failed(new AppError("AUTH","客户登录失效",401)).status).toBe(401);
});
it("sends health despite journal read failure and strips all new fields for old clouds",async()=>{
 const worker={reports:vi.fn().mockRejectedValue(new Error("SECRET")),problems:new Map()} as unknown as Worker;
 const health=new Map();const body=await heartbeatFeedback(worker,[],health,true);
 expect(body).toMatchObject({reports:[],problems:[{code:"RESULT_SAVE"}]});expect(JSON.stringify(body)).not.toContain("SECRET");
 expect(await heartbeatFeedback(worker,[],health,false)).toEqual({protocol:1,snapshots:[],reports:[]});
 expect(legacyFeedback({message:"兼容",problem:makeProblem("UNKNOWN","x"),nested:{processKnown:true,authorization:"present",query:"failed",verification:"failed",problems:[]}})).toEqual({message:"兼容",nested:{}});
});
it.each(["AGENT_AUTH","YOUTUBE_AUTH","GOOGLE_AUTH"])("does not sign out for %s even with a business 401",async code=>{
 const dispatchEvent=vi.fn();vi.stubGlobal("window",{dispatchEvent});vi.stubGlobal("fetch",vi.fn(async()=>Response.json({problem:makeProblem(code,"业务身份失败")},{status:401})));
 await expect(api("/api/status")).rejects.toMatchObject({problem:{code}});expect(dispatchEvent).not.toHaveBeenCalled();
});
it.each([401,403,429,503])("classifies non-JSON HTTP %s without exposing HTML",async status=>{
 const dispatchEvent=vi.fn();vi.stubGlobal("window",{dispatchEvent});vi.stubGlobal("fetch",vi.fn(async()=>new Response("<html>SECRET</html>",{status})));
 await expect(api("/api/status")).rejects.toMatchObject({status});expect(dispatchEvent).toHaveBeenCalledTimes(status===401?1:0);
});
it("bounds a write wait, reports unknown outcome and never retries it",async()=>{
 const fetcher=vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(options.signal.reason))));vi.stubGlobal("fetch",fetcher);
 await expect(api("/api/control",{method:"POST",timeoutMs:10})).rejects.toMatchObject({problem:{outcome:"unknown"}});expect(fetcher).toHaveBeenCalledOnce();
});
it("signals a changed browser identity without replaying a stale control request",async()=>{
 const dispatchEvent=vi.fn();const fetcher=vi.fn(async()=>Response.json({problem:makeProblem("ACCOUNT_CHANGED","账号已切换")},{status:409}));vi.stubGlobal("window",{dispatchEvent});vi.stubGlobal("fetch",fetcher);setRequestMember("alice");
 await expect(api("/api/control",{method:"POST"})).rejects.toMatchObject({problem:{code:"ACCOUNT_CHANGED"},status:409});expect(fetcher).toHaveBeenCalledOnce();expect((fetcher.mock.calls as unknown as [string,RequestInit][])[0][1].headers).toBeInstanceOf(Headers);expect(new Headers((fetcher.mock.calls as unknown as [string,RequestInit][])[0][1].headers).get("x-livepilot-user")).toBe("alice");expect(dispatchEvent.mock.calls.map(call=>call[0].type)).toEqual(["livepilot-account-changed"]);
});
it("uses the documented read, write, RPC and chunk budgets",async()=>{
 const timeout=vi.spyOn(AbortSignal,"timeout");vi.stubGlobal("fetch",vi.fn(async()=>Response.json({ok:true})));
 try{await api("/api/instances");await api("/api/members",{method:"POST"});await api("/api/status");await api("/api/uploads/x",{method:"PUT"});expect(timeout.mock.calls.map(c=>c[0])).toEqual([15000,30000,60000,120000]);}finally{timeout.mockRestore();}
});
it("keeps user cancellation neutral while preserving uncertain write outcome",async()=>{
 const abort=new AbortController();vi.stubGlobal("fetch",vi.fn(async()=>{abort.abort();throw new Error("SECRET");}));
 await expect(api("/api/control",{method:"POST",signal:abort.signal})).rejects.toMatchObject({problem:{code:"CANCELLED",severity:"info",outcome:"unknown"}});
});
