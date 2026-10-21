/** 真Executor/Runner/Commands/Control/Service组合回归；OBS/Google端口合成，不执行真实开停播或上传。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Executor } from "@/agent/executor";
import { Transport } from "@/agent/transport";
import { VideoApi } from "@/core/youtube/video-api";
import { scanPublishingAssets } from "@/core/publishing/assets";
import { config } from "@/core/config";
import type { Dashboard } from "@/shared/types";
import type { RemoteTask } from "@/shared/remote";
import { fixtureJob } from "./publishing-fixtures";
import { runtimeActionMode, runtimeSummary } from "@/app/components/broadcast-runtime-model";
let root: string, executor: Executor;
/** 本例所有本机数据均在独立临时目录，且禁止任何未替代的外部HTTP。 */
beforeEach(async () => {
  root=await mkdtemp(path.join(os.tmpdir(),"broadcast-observation-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT",path.join(root,"data"));vi.stubEnv("LIVEPILOT_MEDIA_ROOT",root);vi.stubEnv("LIVEPILOT_INSTANCES","main,obs_two");vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY","a".repeat(64));
  vi.stubGlobal("fetch",vi.fn(async()=>{throw Error("Unexpected external request")}));
  executor=new Executor(new Transport("https://cloud.example.com","pc","b".repeat(64)));
});
/** 排空正式Runner再删本例数据，不触碰已有配置。 */
afterEach(async()=>{await executor.stopPublishing();vi.unstubAllEnvs();vi.unstubAllGlobals();if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith("broadcast-observation-"))throw Error("unsafe cleanup");await rm(root,{recursive:true,force:true});});
/** 新鲜本机样本可模拟明确停止、在播、重连或OBS未知，不依赖平台缓存时钟。 */
function dashboard(streaming: boolean|null=false,reconnecting=false):Dashboard{return {busy:false,state:{phase:"live",stage:"Synthetic",broadcastId:"b1",updatedAt:new Date().toISOString()},obs:{ready:streaming!==null,running:true,streaming,reconnecting},youtube:{connected:true,query:"ready",lifecycle:streaming===true?"live":"complete"},media:{videos:[],music:[]},configuration:{missing:[],privacy:"private",madeForKids:false}};}
/** 正式RPC执行入口，任务仅使用合成身份，不经过任何公网传输。 */
function check(id="main") {return executor.execute({id:crypto.randomUUID(),agentId:"pc",instanceId:id,actor:"alice",payload:{kind:"broadcast-read"}} as RemoteTask);}
it("manual reads preserve live/unknown/reconnecting protection across instances and failures until authoritative stop",async()=>{
  const main=executor.services.get("main")!, second=executor.services.get("obs_two")!;
  const reading=vi.spyOn(main,"checkYouTube").mockResolvedValue(dashboard(true));vi.spyOn(second,"dashboard").mockResolvedValue(dashboard(false));
  await executor.snapshot("obs_two");
  for(const sample of [dashboard(true),dashboard(null),dashboard(false,true)]){
    reading.mockResolvedValue(sample);await check();await expect(executor.publishing.previewWork(new AbortController().signal,async()=>"allowed")).rejects.toMatchObject({code:"PREVIEW_BUSY"});
  }
  reading.mockRejectedValue(Error("synthetic network failure"));await expect(check()).rejects.toThrow("synthetic network failure");await expect(executor.publishing.previewWork(new AbortController().signal,async()=>"allowed")).rejects.toMatchObject({code:"PREVIEW_BUSY"});
  reading.mockResolvedValue(dashboard(false));await check();await expect(executor.publishing.previewWork(new AbortController().signal,async()=>"allowed")).resolves.toBe("allowed");
  const now = Date.now(); const time = vi.spyOn(Date,"now").mockReturnValue(now + 21_000);
  await expect(executor.publishing.previewWork(new AbortController().signal,async()=>"allowed")).rejects.toMatchObject({code:"PREVIEW_BUSY"}); time.mockRestore();
  vi.spyOn(second,"checkYouTube").mockResolvedValue(dashboard(true));await check("obs_two");await expect(executor.publishing.previewWork(new AbortController().signal,async()=>"allowed")).rejects.toMatchObject({code:"PREVIEW_BUSY"});
});
it("real Runner chunks retain live upload rate before and after repeated manual reads",async()=>{
  await mkdir(path.join(root,"videos"));await writeFile(path.join(root,"videos","movie.mp4"),Buffer.alloc(4*262144,42));
  const job=fixtureJob((await scanPublishingAssets(root)).assets[0]);job.policy.concurrency=1;job.policy.liveUploadMbps=5;job.policy.uploadMbps=20;
  const main=executor.services.get("main")!;const token={accessToken:"synthetic",refreshToken:"synthetic",expiresAt:Date.now()+3600000,channelId:job.profile.channelId,channel:"Synthetic"};
  vi.spyOn(main.auth,"tokens").mockResolvedValue(token);vi.spyOn(main,"dashboard").mockResolvedValue(dashboard(true));vi.spyOn(main,"checkYouTube").mockResolvedValue(dashboard(true));
  vi.spyOn(executor.services.get("obs_two")!,"dashboard").mockResolvedValue(dashboard(false));await executor.snapshot("main");await executor.snapshot("obs_two");
  vi.spyOn(VideoApi.prototype,"begin").mockResolvedValue("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic");
  const rates:number[]=[];vi.spyOn(VideoApi.prototype,"chunk").mockImplementation(async(_uri,_file,offset,total,bytes,rate)=>{rates.push(rate);await check();const end=Math.min(total,offset+bytes);return {offset:end,...(end===total?{videoId:"synthetic-video"}:{})};});
  await executor.publishing.apply(job);await executor.publishing.tick();await vi.waitFor(()=>expect(executor.publishing.busy).toBe(false));
  expect(rates).toEqual([5,5,5,5]);expect((await executor.publishing.reports())[0]).toMatchObject({videoId:"synthetic-video",state:"processing"});expect(fetch).not.toHaveBeenCalled();
});
it("real successful stop survives Commands cache invalidation and renders ended without fabricating checkedAt or polling",async()=>{
  const app=executor.services.get("main")!;let streaming=true,lifecycle="live";
  vi.spyOn(app.obs,"status").mockImplementation(async()=>({ready:true,running:true,streaming}));vi.spyOn(app.obs,"stopStream").mockImplementation(async()=>{streaming=false});
  vi.spyOn(app.auth,"tokens").mockResolvedValue({accessToken:"synthetic",refreshToken:"synthetic",expiresAt:Date.now()+3600000,channelId:"channel",channel:"Synthetic"});
  vi.spyOn(app.youtube,"channel").mockResolvedValue({id:"channel",title:"Synthetic"});const read=vi.spyOn(app.youtube,"broadcast").mockImplementation(async()=>({id:"b1",snippet:{title:"Synthetic"},status:{lifeCycleStatus:lifecycle},contentDetails:{}}));
  vi.spyOn(app.youtube,"transition").mockImplementation(async(_id,phase)=>{lifecycle=phase});
  await app.control.storage.write("control.json",{phase:"live",stage:"Synthetic",channelId:"channel",broadcastId:"b1",obsStartRequested:true,updatedAt:new Date().toISOString()});
  await app.commands.accept({requestId:"synthetic-stop",instanceId:"main",action:"stop"},"alice");await app.commands.run("synthetic-stop");expect((await app.commands.get("synthetic-stop"))?.status).toBe("succeeded");
  const calls=read.mock.calls.length;const dto=await app.dashboard();expect(dto.state.phase).toBe("stopped");expect(dto.youtube.checkedAt).toBeUndefined();expect(dto.youtube.lifecycle).toBe("complete");
  expect(runtimeSummary({data:dto,stale:false,busy:false,live:false})).toMatchObject({label:"本场已结束"});expect(runtimeActionMode({data:dto,stale:false,busy:false,live:false})).toBe("start");expect(read).toHaveBeenCalledTimes(calls);expect(config("main").dataDir.startsWith(root)).toBe(true);
});
