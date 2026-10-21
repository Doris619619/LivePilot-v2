/** OAuth与撤销的跨模块准入回归：真实Cloud账号/任务/账本及Executor，Google只返回合成响应。 */
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore, setAgentOwner } from "@/cloud/agents";
import { accessStore, emptyAccess } from "@/server/access";
import { createPublishingAccount, claimPublishingAccount, agentPublishingAccounts, syncPublishingAccounts } from "@/cloud/publishing-accounts";
import { acceptPublishingPrivacy, requestPublishingAccountCleanup, requestPublishingCleanup, publishingCleanups, completePublishingCleanup, reportPublishing } from "@/cloud/publishing";
import { enqueue, pollTasks, reportTasks } from "@/cloud/tasks";
import { admitYouTube, reportYouTubeResult, updateYouTubePolicy } from "@/cloud/youtube-usage";
import { quotaDay } from "@/core/publishing/schedule";
import { PRIVACY_VERSION, type PublishingAccountReport, type PublishingReport } from "@/shared/publishing";
import type { TaskPayload } from "@/shared/remote";
import type { YouTubeAdmit, YouTubeResult } from "@/shared/youtube-usage";
import { Executor } from "@/agent/executor";
import { Transport } from "@/agent/transport";
import { AgentYouTubeUsage } from "@/agent/youtube-usage";
import { installYouTubeRuntime } from "@/core/youtube/usage";
import { seal, Store } from "@/core/storage";
import { config } from "@/core/config";
import { cloudStore } from "@/cloud/store";
import { AppError } from "@/core/errors";
const alice={username:"alice",role:"customer" as const};const agentId="lifecycle_pc";const clientId="synthetic-lifecycle-client";
let transport:Transport;let loseCleanupConfirmation=false;let syncs=0;let root:string;let executor:Executor;let runtime:AgentYouTubeUsage;let google:ReturnType<typeof vi.fn>;const attempts:YouTubeAdmit[]=[];
/** 本机网络替身只分派到真实Cloud函数；没有always-allow准入。 */
beforeEach(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),"livepilot-youtube-lifecycle-"));vi.stubEnv("LIVEPILOT_DATA_ROOT",root);vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY","a".repeat(64));vi.stubEnv("LIVEPILOT_INSTANCES","main");vi.stubEnv("LIVEPILOT_ORIGIN","https://synthetic.invalid");vi.stubEnv("GOOGLE_CLIENT_ID",clientId);vi.stubEnv("GOOGLE_CLIENT_SECRET","synthetic-secret");
 const access=emptyAccess();access.users.push({...alice,salt:"synthetic",hash:"synthetic",revision:randomUUID(),disabled:false});await accessStore().write("access.json",access);
 const pair=await createPairing(agentId,"Synthetic",alice.username);await pairAgent(agentId,pair.code,"b".repeat(64));const session=await openSession(agentId,randomUUID(),[{id:"main",name:"Main"},{id:"other",name:"Other"}]);await heartbeatAgent(agentId,session.session,[]);await agentStore(agentId).write("capabilities.json",["publishing-v1","publishing-accounts-v1","youtube-quota-v1","youtube-usage-v1"]);await acceptPublishingPrivacy(alice,PRIVACY_VERSION);await updateYouTubePolicy({baseline:{day:quotaDay(),units:0,uploads:0,source:"conservative-estimate"}},"Synthetic admin");
 transport=new Transport("https://synthetic.invalid",agentId,"b".repeat(64));transport.session=session.session;attempts.length=0;loseCleanupConfirmation=false;syncs=0;
 vi.spyOn(transport,"post").mockImplementation(async(route,raw)=>{
  if(route.endsWith("youtube-quota/admit")){const input=raw as YouTubeAdmit;attempts.push(input);return await admitYouTube(agentId,input) as never;}
  if(route.endsWith("youtube-quota/result"))return await reportYouTubeResult(agentId,raw as YouTubeResult) as never;
  if(route.endsWith("publishing/accounts-binding")){const v=raw as {accountId:string;instanceId:string;channelId:string;channel:string;channelCheckedAt:number;confirm:boolean};return await claimPublishingAccount(agentId,v.accountId,v.instanceId,v.channelId,v.channel,v.confirm,v.channelCheckedAt) as never;}
  if(route.endsWith("publishing/sync")){syncs++;const v=raw as {reports:PublishingReport[];accounts?:PublishingAccountReport[]};const acknowledged=await reportPublishing(agentId,v.reports);const accounts=v.accounts?await syncPublishingAccounts(agentId,v.accounts):await agentPublishingAccounts(agentId);return {acknowledged,accounts,cleanups:await publishingCleanups(agentId)} as never;}
  if(route.endsWith("publishing/cleanup")){const result=await completePublishingCleanup(agentId,(raw as {id:string}).id);if(loseCleanupConfirmation){loseCleanupConfirmation=false;throw new AppError("CLOUD_NETWORK","Synthetic lost cleanup confirmation",503);}return result as never;}
  throw new Error("Unexpected local Cloud route");
 });
 runtime=new AgentYouTubeUsage(transport);runtime.connect(["youtube-quota-v1","youtube-usage-v1"]);installYouTubeRuntime(runtime);executor=new Executor(transport);
 google=vi.fn(async(url:string)=>{if(url==="https://oauth2.googleapis.com/token")return Response.json({access_token:"synthetic-access",refresh_token:"synthetic-refresh",expires_in:3600});if(url==="https://oauth2.googleapis.com/revoke")return Response.json({});if(url.startsWith("https://www.googleapis.com/youtube/v3/channels?"))return Response.json({items:[{id:"synthetic_channel",snippet:{title:"Synthetic channel"}}]});throw new Error("Unexpected Google request");});vi.stubGlobal("fetch",google);
});
/** 只清理本例隔离目录，退出后台循环后再停止真实本地计量运行时。 */
afterEach(async()=>{await executor?.stopPublishing();await runtime?.stop();installYouTubeRuntime();vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith("livepilot-youtube-lifecycle-"))throw new Error("Unsafe cleanup");await rm(root,{recursive:true,force:true});});
/** 真正建立、投递、接受和回报短任务，OAuth上下文必须对应这些Cloud任务记录。 */
async function executeTask(payload:TaskPayload){const saved=await enqueue({agentId,instanceId:"main"},alice.username,payload);const task=(await pollTasks(agentId)).find(value=>value.id===saved.id)!;await reportTasks(agentId,[{id:task.id,status:"running"}]);const result=await executor.execute(task);await reportTasks(agentId,[{id:task.id,status:"succeeded",result}]);return {task,result};}
/** 有合法路由和授权快照的合成账号，用于独立验证撤销而无需先通过首次OAuth。 */
async function seededAccount(){const account=await createPublishingAccount(alice,agentId,"main","Synthetic publish");await claimPublishingAccount(agentId,account.id,"main","synthetic_channel","Synthetic",true,Date.now());await executor.publishingAccounts.begin(account.id,"main",alice.username);const storage=executor.publishingAccounts.store(account.id);await storage.write("account.json",{id:account.id,instanceId:"main",channelId:"synthetic_channel",channel:"Synthetic",connectedAt:Date.now(),channelCheckedAt:Date.now()});await storage.write("youtube.enc",seal({accessToken:"synthetic-access",refreshToken:"synthetic-refresh",expiresAt:Date.now()+3600000,channelId:"synthetic_channel",channel:"Synthetic"}));return account;}
it("first publishing OAuth reaches token exchange and channel identity before binding connected",async()=>{
 const account=await createPublishingAccount(alice,agentId,"main","First publish");const begin=await executeTask({kind:"publishing-account-oauth-begin",accountId:account.id});const value=begin.result as {cookie:string;url:string};const finished=await executeTask({kind:"publishing-account-oauth-finish",accountId:account.id,cookie:value.cookie,state:new URL(value.url).searchParams.get("state")!,code:"synthetic-code"});expect(finished.result).toEqual({ok:true});expect((await agentPublishingAccounts(agentId))[0].status).toBe("connected");expect(attempts.map(input=>input.method)).toEqual(["oauth.token","channels.list"]);expect(attempts.every(input=>input.operationId===finished.task.id&&input.accountId===account.id)).toBe(true);expect(google).toHaveBeenCalledTimes(2);
});
it("pending account cleanup scopes revoke to its original request and reaches both terminal markers",async()=>{
 const account=await seededAccount();const cleanup=await requestPublishingAccountCleanup(alice,account.id);executor.connectPublishing(true,true);
 // Cloud确认先落盘，本机随后完成自己的标记；两个持久终态均是本例的成功条件。
 await vi.waitFor(async()=>{expect((await agentPublishingAccounts(agentId))[0].status).toBe("deleted");expect(await executor.publishingAccounts.store(account.id).read("account.json")).toMatchObject({deleted:true,purge:{pending:false}});},{timeout:4000});
 expect(attempts.filter(input=>input.method==="oauth.revoke")).toMatchObject([{operationId:cleanup.id,accountId:account.id,instanceId:"main",purpose:"authorization"}]);expect(google).toHaveBeenCalledExactlyOnceWith("https://oauth2.googleapis.com/revoke",expect.anything());
});

/** 单次准入使用真实项目指纹；伪造purpose本身不能创造合法生命周期操作。 */
function request(input:Partial<YouTubeAdmit>={}):YouTubeAdmit{return {attemptId:randomUUID(),clientFingerprint:createHash("sha256").update(clientId).digest("hex"),instanceId:"main",purpose:"authorization",method:"oauth.token",trigger:"oauth-finish",...input};}
/** 构造尚未执行的真实Cloud授权任务，后续直接检查它的准入边界。 */
async function oauthTask(accountId:string,cancelled=false){const task=await enqueue({agentId,instanceId:"main"},alice.username,{kind:"publishing-account-oauth-finish",accountId,cookie:"e".repeat(64),state:"Synthetic state",code:cancelled?"":"Synthetic code",cancelled});return task;}
it("rejects invented authorization, queued or cancelled OAuth, wrong method, account and instance",async()=>{
 const account=await createPublishingAccount(alice,agentId,"main","Unbound");const other=await createPublishingAccount(alice,agentId,"main","Other");await expect(admitYouTube(agentId,request({accountId:account.id}))).rejects.toMatchObject({code:"FORBIDDEN"});await expect(admitYouTube(agentId,request({accountId:account.id,operationId:randomUUID()}))).rejects.toMatchObject({code:"FORBIDDEN"});
 const task=await oauthTask(account.id);await expect(admitYouTube(agentId,request({accountId:account.id,operationId:task.id}))).rejects.toMatchObject({code:"FORBIDDEN"});await pollTasks(agentId);
 for(const patch of [{method:"videos.insert",purpose:"publishing"},{method:"playlists.list"},{accountId:other.id},{instanceId:"other"},{jobId:randomUUID()}] as Partial<YouTubeAdmit>[]){await expect(admitYouTube(agentId,request({accountId:account.id,operationId:task.id,...patch}))).rejects.toBeDefined();}
 await reportTasks(agentId,[{id:task.id,status:"succeeded",result:{ok:true}}]);const cancelled=await oauthTask(account.id,true);await pollTasks(agentId);await expect(admitYouTube(agentId,request({accountId:account.id,operationId:cancelled.id}))).rejects.toMatchObject({code:"FORBIDDEN"});expect(google).not.toHaveBeenCalled();
});
it("allows only a delivered fresh OAuth-finish task while unbound and rejects its expiration or terminal state",async()=>{
 const account=await createPublishingAccount(alice,agentId,"main","Unbound");const task=await oauthTask(account.id);await pollTasks(agentId);expect((await admitYouTube(agentId,request({accountId:account.id,operationId:task.id}))).allowed).toBe(true);
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(task.expiresAt+1);await expect(admitYouTube(agentId,request({accountId:account.id,operationId:task.id}))).rejects.toMatchObject({code:"FORBIDDEN"});vi.useRealTimers();await reportTasks(agentId,[{id:task.id,status:"failed",error:"Synthetic cancellation"}]);await expect(admitYouTube(agentId,request({accountId:account.id,operationId:task.id}))).rejects.toMatchObject({code:"FORBIDDEN"});expect(google).not.toHaveBeenCalled();
});
it("does not let an OAuth-begin task authorize token exchange or an old owner keep connecting",async()=>{
 const account=await createPublishingAccount(alice,agentId,"main","Unbound");const task=await enqueue({agentId,instanceId:"main"},alice.username,{kind:"publishing-account-oauth-begin",accountId:account.id});await pollTasks(agentId);await expect(admitYouTube(agentId,request({accountId:account.id,operationId:task.id}))).rejects.toMatchObject({code:"FORBIDDEN"});await setAgentOwner(agentId,"bob");await expect(admitYouTube(agentId,request({accountId:account.id,operationId:task.id}))).rejects.toMatchObject({code:"ACCOUNT"});expect(google).not.toHaveBeenCalled();
});
it("requires a pending matching cleanup and does not reopen OAuth or uploads during cleanup",async()=>{
 const account=await seededAccount();const cleanup=await requestPublishingAccountCleanup(alice,account.id);const other=await createPublishingAccount(alice,agentId,"main","Other cleanup");const otherCleanup=await requestPublishingAccountCleanup(alice,other.id);await expect(admitYouTube(agentId,request({accountId:account.id,operationId:otherCleanup.id,method:"oauth.revoke"}))).rejects.toMatchObject({code:"FORBIDDEN"});await expect(admitYouTube(agentId,request({accountId:other.id,operationId:cleanup.id,method:"oauth.revoke"}))).rejects.toMatchObject({code:"FORBIDDEN"});const input={accountId:account.id,operationId:cleanup.id};expect((await admitYouTube(agentId,request({...input,method:"oauth.revoke"}))).allowed).toBe(true);
 for(const patch of [{operationId:randomUUID()},{instanceId:"other"},{accountId:randomUUID()},{operationId:undefined},{purpose:"interactive"},{jobId:randomUUID()}] as Partial<YouTubeAdmit>[]){await expect(admitYouTube(agentId,request({...input,method:"oauth.revoke",...patch}))).rejects.toBeDefined();}
 for(const patch of [{method:"oauth.token"},{method:"channels.list"},{method:"videos.insert",purpose:"publishing"}] as Partial<YouTubeAdmit>[]){await expect(admitYouTube(agentId,request({...input,...patch}))).rejects.toMatchObject({code:"CLEANUP"});}
 const pair=await createPairing("foreign_pc","Foreign");await pairAgent("foreign_pc",pair.code,"c".repeat(64));await openSession("foreign_pc",randomUUID(),[{id:"main",name:"Main"}]);await expect(admitYouTube("foreign_pc",request({...input,method:"oauth.revoke"}))).rejects.toMatchObject({code:"ACCOUNT"});
 await completePublishingCleanup(agentId,cleanup.id);await expect(admitYouTube(agentId,request({...input,method:"oauth.revoke"}))).rejects.toMatchObject({code:"FORBIDDEN"});expect(google).not.toHaveBeenCalled();
});
it("keeps the original pending cleanup retryable after its existing deadline",async()=>{
 const account=await seededAccount();const cleanup=await requestPublishingAccountCleanup(alice,account.id);const state=await cloudStore().read<{cleanups:{id:string;deadline:number}[]}>("publishing-accounts.json");state!.cleanups.find(record=>record.id===cleanup.id)!.deadline=Date.now()-1;await cloudStore().write("publishing-accounts.json",state);expect((await admitYouTube(agentId,request({accountId:account.id,operationId:cleanup.id,method:"oauth.revoke"}))).allowed).toBe(true);
});
it("legacy cleanup carries its own request while revoking and reaches Cloud and local completion",async()=>{
 const storage=new Store(config("main").dataDir);await storage.write("youtube.enc",seal({accessToken:"synthetic-access",refreshToken:"synthetic-refresh",expiresAt:Date.now()+3600000,channelId:"legacy_channel",channel:"Synthetic"}));const cleanup=await requestPublishingCleanup(alice,agentId,"main");for(const method of ["oauth.token","channels.list","videos.insert"] as const){await expect(admitYouTube(agentId,request({method,purpose:method==="videos.insert"?"publishing":"authorization",operationId:cleanup.id}))).rejects.toMatchObject({code:"CLEANUP"});}executor.connectPublishing(true,true);
 // legacy同样分两次持久确认，不能把Cloud清理列表为空当成本机最后写入已完成。
 await vi.waitFor(async()=>{expect(await publishingCleanups(agentId)).toEqual([]);expect(await storage.read("publishing-purge.json")).toMatchObject({pending:false});},{timeout:4000});
 expect(attempts.filter(input=>input.method==="oauth.revoke")).toMatchObject([{operationId:cleanup.id,instanceId:"main",purpose:"authorization"}]);expect(attempts.find(input=>input.method==="oauth.revoke")?.accountId).toBeUndefined();expect(google).toHaveBeenCalledTimes(1);
});
it("lost cleanup acknowledgement resumes local deletion from Cloud deleted without another Google revoke",async()=>{
 const account=await seededAccount();await requestPublishingAccountCleanup(alice,account.id);loseCleanupConfirmation=true;executor.connectPublishing(true,true);await vi.waitFor(async()=>expect(await executor.publishingAccounts.store(account.id).read("account.json")).toMatchObject({deleted:true,purge:{pending:false}}),{timeout:5000});expect(syncs).toBeGreaterThanOrEqual(2);expect((await agentPublishingAccounts(agentId))[0].status).toBe("deleted");expect(google).toHaveBeenCalledTimes(1);expect(attempts.filter(input=>input.method==="oauth.revoke")).toHaveLength(1);
});
it("accepts legacy state without a cleanup list while refusing an invented revoke request",async()=>{
 const {publishingStore}=await import("@/cloud/publishing");await publishingStore().write("state.json",{policy:{otherUnitsPerDay:100,uploadsPerDay:1}});
 expect((await admitYouTube(agentId,request({method:"videos.list",purpose:"publishing",trigger:"publishing-tick"}))).allowed).toBe(true);
 await expect(admitYouTube(agentId,request({method:"oauth.revoke",operationId:randomUUID()}))).rejects.toMatchObject({code:"FORBIDDEN"});expect(google).not.toHaveBeenCalled();
});
