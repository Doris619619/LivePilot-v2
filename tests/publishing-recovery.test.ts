/** 发布异常恢复回归：真实Cloud事务、Runner检查点和目录归档，所有网络均使用合成响应。 */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore } from '@/cloud/agents';
import { cloudStore } from '@/cloud/store';
import { accessStore, emptyAccess } from '@/server/access';
import { connectPublishingAccount, acceptPublishingPrivacy, savePublishingPolicy, savePublishingProfile, previewPublishingBatch, confirmPublishingBatch, previewPublishingPlan, confirmPublishingPlan, archivePublishingPlan, changePublishingJob, publishingStore, publishingView, publishingTick, reportPublishing } from '@/cloud/publishing';
import { createPublishingAccount, claimPublishingAccount, agentPublishingAccounts, syncPublishingAccounts, publishingAccountCleanups } from '@/cloud/publishing-accounts';
import { PRIVACY_VERSION, defaultPolicy, type JobSpec } from '@/shared/publishing';
import { fixtureJob, fixtureApi } from './publishing-fixtures';
import { ensurePublishingRoot, scanPublishingPackages } from '@/core/publishing/packages';
import { archivePublishingBatch } from '@/core/publishing/archive';
import { PublishingRunner } from '@/core/publishing/runner';
import { PublishingStore } from '@/core/publishing/storage';
import { YouTubeAuth } from '@/core/youtube/auth';
import { VideoApi, VideoApiError } from '@/core/youtube/video-api';
import { seal } from '@/core/storage';
import { finishRemoteOAuth } from '@/cloud/oauth';
import { pollTasks, reportTasks } from '@/cloud/tasks';
import { seedTestYouTubeBaseline } from './youtube-usage-baseline';
const remote = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/cloud/tasks', async orig => ({ ...await orig<typeof import("@/cloud/tasks")>(), rpc: remote.rpc }));
const alice={username:'alice',role:'customer' as const}, admin={username:'admin',role:'admin' as const};
const auditRoot=os.tmpdir();
let root:string;
beforeEach(async()=>{
 root=await mkdtemp(path.join(auditRoot,'publishing-recovery-'));
 vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
 vi.stubEnv('LIVEPILOT_DATA_ROOT',root); vi.stubEnv('LIVEPILOT_ENCRYPTION_KEY','a'.repeat(64)); vi.stubEnv('LIVEPILOT_INSTANCES','main');vi.stubEnv('LIVEPILOT_ORIGIN','https://synthetic.invalid');
 const access=emptyAccess(); access.users.push(...[alice,admin].map(x=>({...x,salt:'synthetic',hash:'synthetic',revision:randomUUID(),disabled:false}))); await accessStore().write('access.json',access);
 const pair=await createPairing('pc','Synthetic','alice'); await pairAgent('pc',pair.code,'b'.repeat(64)); const session=await openSession('pc',randomUUID(),[{id:'main',name:'Main'}]); await heartbeatAgent('pc',session.session,[]);
 await agentStore('pc').write('capabilities.json',['publishing-v1','publishing-v2','publishing-consent-v2','publishing-accounts-v1','publishing-recovery-v1','publishing-auth-generation-v1']);
 await cloudStore().write('bindings.json',[{agentId:'pc',instanceId:'main',channelId:'channel_one',confirmed:true}]);
 await savePublishingPolicy(admin,{...defaultPolicy}); await acceptPublishingPrivacy(alice,PRIVACY_VERSION);
 remote.rpc.mockReset(); remote.rpc.mockResolvedValue({assets:[fixtureJob().asset],thumbnails:[],channelId:'channel_one',channel:'Synthetic'});
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Unexpected external request: network prohibited');}));
});
/** 组合配额保护后显式确认合成零历史基线，恢复测试不依赖未知预算默认放行。 */
beforeEach(async()=>{await seedTestYouTubeBaseline();});
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('publishing-recovery-'))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});});
/** 建立合成同频道发布账号，不交换任何真实OAuth凭据。 */
async function connected(){const a=await createPublishingAccount(alice,'pc','main','Synthetic');await claimPublishingAccount('pc',a.id,'main','channel_one','Synthetic',true,Date.now());return a;}
/** 保留真实begin队列准入与终态回报；只替代Agent PKCE/Google回复，避免mockRPC遗留假在途任务。 */
async function beginAuthorization(accountId:string){
 const reply={url:'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({redirect_uri:'https://synthetic.invalid/api/youtube/callback',state:'publishing-'+accountId+'.'+'d'.repeat(64)}),cookie:'e'.repeat(64)};
 remote.rpc.mockResolvedValueOnce(reply);const browser=await connectPublishingAccount(alice,accountId);
 const task=(await pollTasks('pc')).find(task=>task.payload.kind==='publishing-account-oauth-begin'&&task.payload.accountId===accountId);
 expect(task).toBeDefined();await reportTasks('pc',[{id:task!.id,status:'succeeded',result:reply}]);return browser;
}
/** 走真实确认流程建立私密或定时公开任务，网络始终由替身处理。 */
async function flatJob(publicSchedule=false){const p=fixtureJob().profile;p.scheduled=publicSchedule;p.privacy=publicSchedule?'public':'private';const profile=await savePublishingProfile(alice,p);const b=await previewPublishingBatch(alice,profile.id,[fixtureJob().asset.id]);return (await confirmPublishingBatch(alice,b.id,false,true))[0];}
/** 固定已上传的加密检查点，验证重启恢复沿用原videoId。 */
async function checkpoint(spec:JobSpec,state='finalizing',videoId='video_one'){
 const storage=new PublishingStore(path.join(root,'checkpoints-'+randomUUID()));
 await storage.write('entries.enc',seal([{spec,report:{id:spec.id,revision:spec.revision,sequence:1,state,offset:spec.asset.size,total:spec.asset.size,videoId,updatedAt:Date.now(),metadata:{title:'Synthetic',description:'Description'}},playlistsDone:[],failures:0}]));return storage;
}
/** 等待Runner短异步阶段落盘，不依赖真实上传耗时。 */
async function settle(runner:PublishingRunner){for(let i=0;i<1000&&runner.busy;i++)await new Promise(r=>setTimeout(r,2));expect(runner.busy).toBe(false);}
it('F01 persistent 401 performs one controlled token refresh and stops after one GET retry',async()=>{
 const access=vi.fn(async()=>({accessToken:'synthetic'})); const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:{errors:[{reason:'authError'}]}}),{status:401})); vi.stubGlobal('fetch',fetcher);
 const api=new VideoApi({access} as unknown as YouTubeAuth,async()=>{});await expect(api.list(['video_one'])).rejects.toMatchObject({code:'YOUTUBE_AUTH',retryable:false});expect(access).toHaveBeenCalledTimes(3);expect(access).toHaveBeenNthCalledWith(2,"synthetic");expect(fetcher).toHaveBeenCalledTimes(2);

});
it('F01 automatic authorization failure preserves plans and checkpoints until same-channel reauthorization',async()=>{
 const account=await connected();const profile=await savePublishingProfile(alice,{...fixtureJob().profile,accountId:account.id});
 const first=await previewPublishingBatch(alice,profile.id,[fixtureJob().asset.id]);const [job]=await confirmPublishingBatch(alice,first.id,false,true);
  await previewPublishingBatch(alice,profile.id,[fixtureJob().asset.id]);
 const media=path.join(root,'F01-media');await ensurePublishingRoot(media);const folder=path.join(media,'Inbox','DraftBatch','001');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'video.mp4'),'synthetic');const scan=await scanPublishingPackages(media);
 remote.rpc.mockResolvedValue({...scan,thumbnails:[],channelId:'channel_one'});const rule={timezone:'UTC',startDate:'2026-10-01',weeklySlots:[{weekday:4,time:'20:00'}],preuploadDays:28};await previewPublishingPlan(alice,profile.id,scan.batches[0].id,rule);await previewPublishingPlan(alice,profile.id,scan.batches[0].id,rule);
 const before=await publishingView(alice);expect(before.jobs.length).toBe(1);expect(before.profiles.length).toBe(1);
 const storage=await checkpoint(job.spec,'scheduled');
 const access=vi.fn(async()=>({accessToken:'synthetic'}));vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:401})));const api=new VideoApi({access} as unknown as YouTubeAuth,async()=>{});const unschedule=vi.spyOn(api,'unschedule');const runner=new PublishingRunner(new Map(),{store:storage,api:()=>api});
 await runner.tick();const [report]=await runner.reports();expect(report.authorizationInvalid).toBe(true);expect(report.state).toBe('needs_attention');
 // Report belongs to the same original Cloud job ID, independent of local auth adapter.
 await reportPublishing('pc',[report]);const after=await publishingView(alice);const accountAfter=(await agentPublishingAccounts('pc')).find(x=>x.id===account.id);
 expect(after.jobs).toHaveLength(1);expect(after.profiles).toHaveLength(1);expect(accountAfter?.status).toBe('needs_reauthorization');expect(unschedule).not.toHaveBeenCalled();
  const raw=await publishingStore().read<{batches:unknown[]}>('state.json');expect(raw!.batches).toHaveLength(2);expect(before.plans).toHaveLength(2);expect(after.plans).toHaveLength(2);expect(await publishingAccountCleanups('pc')).toEqual([]);
 await syncPublishingAccounts('pc',[{id:account.id,instanceId:'main',channelId:'channel_one',channel:'Synthetic',connectedAt:Date.now()}]);expect((await agentPublishingAccounts('pc'))[0].status).toBe('needs_reauthorization');
 await expect(claimPublishingAccount('pc',account.id,'main','other_channel','Other',true,Date.now())).rejects.toMatchObject({code:'CHANNEL'});
 vi.setSystemTime(Date.now()+1000);const reconnect=await beginAuthorization(account.id);remote.rpc.mockResolvedValueOnce({ok:true});await finishRemoteOAuth(reconnect.state,reconnect.cookie,'alice','Synthetic code',alice);expect((await agentPublishingAccounts('pc'))[0].status).toBe('connected');
 const resumed=await changePublishingJob(alice,job.spec.id,'resume');await runner.apply(resumed.spec);expect((await runner.reports())[0].authorizationInvalid).toBeUndefined();expect((await runner.reports())[0].videoId).toBe('video_one');await runner.stop();
});
it('F01 explicit reconcile defers 401 without authorizationInvalid cleanup signal',async()=>{
 const spec=fixtureJob();spec.revision=2;spec.reconcileRevision=2;const storage=await checkpoint({...spec,revision:1,reconcileRevision:undefined},'scheduled');const {api}=fixtureApi();api.list.mockRejectedValue(new VideoApiError('YOUTUBE_AUTH','Synthetic'));
 const runner=new PublishingRunner(new Map(),{store:storage,api:()=>api});await runner.apply(spec);await runner.tick();const [report]=await runner.reports();expect(report.authorizationInvalid).toBeUndefined();expect(report.state).toBe('scheduled');await runner.stop();
});
it('F11 real archive permits same-name new content while old drafts stay invalid',async()=>{
 const media=path.join(root,'media');await ensurePublishingRoot(media);const folder=path.join(media,'Inbox','Batch01','001');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'video.mp4'),'synthetic version A');
 const account=await connected();const profile=await savePublishingProfile(alice,{...fixtureJob().profile,accountId:account.id,privacy:'public',scheduled:true});
 remote.rpc.mockImplementation(async(_target,_actor,payload)=>payload.kind==='publishing-archive'?archivePublishingBatch(media,payload.batch,payload.archiveId):({...await scanPublishingPackages(media),thumbnails:[],channelId:'channel_one'}));
 const first=(await scanPublishingPackages(media)).batches[0];const rule={timezone:'UTC',startDate:'2026-10-01',weeklySlots:[{weekday:4,time:'20:00'}],preuploadDays:28};
 const draft=await previewPublishingPlan(alice,profile.id,first.id,rule);const plan=await previewPublishingPlan(alice,profile.id,first.id,rule);const [job]=await confirmPublishingPlan(alice,plan.id,plan.revision,false,true);
 await reportPublishing('pc',[{id:job.spec.id,revision:1,sequence:1,state:'published',offset:0,total:job.spec.asset.size,videoId:'video_one',observedPrivacy:'public',updatedAt:Date.now()}]);
 const archived=await archivePublishingPlan(alice,plan.id);expect(archived.state).toBe('complete');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'video.mp4'),'synthetic version B with completely new bytes');
 const second=(await scanPublishingPackages(media)).batches[0];expect(first.id).toBe(second.id);expect(first.version).not.toBe(second.version);expect(first.packages[0].version).not.toBe(second.packages[0].version);expect(first.packages[0].sourceVideo?.version).not.toBe(second.packages[0].sourceVideo?.version);
  const next=await previewPublishingPlan(alice,profile.id,second.id,rule);const [nextJob]=await confirmPublishingPlan(alice,next.id,next.revision,false,true);expect(nextJob.spec.id).not.toBe(job.spec.id);expect(nextJob.spec.asset.version).toBe(second.packages[0].sourceVideo!.version);
 await expect(confirmPublishingPlan(alice,draft.id,draft.revision,false,true)).rejects.toMatchObject({code:'ARCHIVE'});
 await reportPublishing('pc',[{id:nextJob.spec.id,revision:1,sequence:1,state:'published',offset:0,total:nextJob.spec.asset.size,videoId:'video_two',observedPrivacy:'public',updatedAt:Date.now()}]);await expect(archivePublishingPlan(alice,next.id)).resolves.toMatchObject({state:'complete'});
 const history=(await publishingView(alice)).plans;expect(history.find(p=>p.id===plan.id)?.archivedAt).toBeDefined();expect(history.find(p=>p.id===next.id)?.archivedAt).toBeDefined();
});
it('F12 active upload reschedule is delivered outside the first-upload window before an ID report',async()=>{
 const job=await flatJob(true);await publishingTick();await reportPublishing('pc',[{id:job.spec.id,revision:1,sequence:1,state:'uploading',offset:0,total:job.spec.asset.size,updatedAt:Date.now()}]);
 const changed=await changePublishingJob(alice,job.spec.id,'reschedule','2027-10-01T20:00:00Z');await publishingTick();let current=(await publishingView(alice)).jobs[0];expect(current.spec.revision).toBe(2);expect(current.delivery?.revision).toBe(2);
 const queue=await agentStore('pc').read<{records:unknown[]}>('tasks.json');expect(queue!.records).toHaveLength(2);
 // Agent had already obtained the video ID but Cloud had not yet observed it.
 const storage=await checkpoint(job.spec);const {api,videos}=fixtureApi();videos.set('video_one',{id:'video_one',snippet:{channelId:'channel_one'},status:{privacyStatus:'private'},processingDetails:{processingStatus:'succeeded'}});
 const runner=new PublishingRunner(new Map(),{store:storage,api:()=>api});await runner.apply(changed.spec);await runner.tick();await settle(runner);expect(api.finalize).toHaveBeenCalledTimes(1);expect(Date.parse(api.finalize.mock.calls[0][3]!)).toBe(Date.parse(changed.spec.originalPublishAt!));
 await reportPublishing('pc',[{id:job.spec.id,revision:1,sequence:2,state:'scheduled',offset:job.spec.asset.size,total:job.spec.asset.size,videoId:'video_one',effectivePublishAt:job.spec.originalPublishAt,updatedAt:Date.now()}]);await publishingTick();current=(await publishingView(alice)).jobs[0];expect(current.delivery?.revision).toBe(2);await runner.stop();

});
it('F13 repairs only mutable settings and continues the original uploaded video',async()=>{
 const spec=fixtureJob();spec.profile.playlistIds=['deleted_playlist'];const storage=await checkpoint(spec);const {api,videos}=fixtureApi();api.playlist.mockRejectedValue(new VideoApiError('PLAYLIST','Synthetic playlist missing'));
 videos.set('video_one',{id:'video_one',snippet:{channelId:'channel_one'},status:{privacyStatus:'private'},processingDetails:{processingStatus:'succeeded'}});
 const runner=new PublishingRunner(new Map(),{store:storage,api:()=>api});await runner.tick();await settle(runner);expect((await runner.reports())[0].state).toBe('needs_attention');
 const repaired={...spec,revision:2,repairRevision:2,profile:{...spec.profile,playlistIds:[]}};
 await expect(runner.apply({...repaired,profile:{...repaired.profile,channelId:'wrong_channel'}})).rejects.toMatchObject({code:'REQUEST'});
 await expect(runner.apply({...repaired,asset:{...spec.asset,version:'e'.repeat(64)}})).rejects.toMatchObject({code:'REQUEST'});
 await runner.apply(repaired);await runner.tick();await settle(runner);expect(api.playlist).toHaveBeenCalledTimes(1);expect(api.playlist).toHaveBeenCalledWith('video_one','deleted_playlist');expect(api.begin).not.toHaveBeenCalled();expect((await runner.reports())[0]).toMatchObject({state:'completed',videoId:'video_one',revision:2});await runner.stop();
});


/** 明确拒绝短期token时受控刷新；写请求不在HTTP层重放。 */
it('F01 refreshes a still-unexpired token once after a GET 401 and preserves the account',async()=>{
 const storage=new PublishingStore(path.join(root,'auth-refresh'));await storage.write('youtube.enc',seal({accessToken:'old',refreshToken:'refresh',expiresAt:Date.now()+3600000,channelId:'channel_one',channel:'Synthetic'}));
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);if(url.endsWith('/token'))return Response.json({access_token:'new',expires_in:3600});return calls.length===1?new Response('{}',{status:401}):Response.json({items:[{id:'video_one'}]});}));
 const auth=new YouTubeAuth(storage);const api=new VideoApi(auth,async()=>{});expect(await api.list(['video_one'])).toEqual([{id:'video_one'}]);expect(calls.filter(url=>url.endsWith('/token'))).toHaveLength(1);expect(calls).toHaveLength(3);expect((await auth.tokens())?.accessToken).toBe('new');
});
it('F01 refreshes after a write 401 without replaying the side effect',async()=>{
 const storage=new PublishingStore(path.join(root,'auth-write'));await storage.write('youtube.enc',seal({accessToken:'old',refreshToken:'refresh',expiresAt:Date.now()+3600000,channelId:'channel_one',channel:'Synthetic'}));
 const writes=vi.fn(async()=>new Response('{}',{status:401}));vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/token')?Response.json({access_token:'new',expires_in:3600}):writes()));
 const auth=new YouTubeAuth(storage);await expect(new VideoApi(auth,async()=>{}).begin(fixtureJob(),'Synthetic marker')).rejects.toMatchObject({code:'VIDEO_AUTH_REFRESHED',retryable:true});expect(writes).toHaveBeenCalledTimes(1);expect((await auth.tokens())?.accessToken).toBe('new');
});
/** Cloud修复入口的白名单和能力要求独立于Runner检查，不因手工构造请求放宽身份。 */
it('F13 Cloud repairs the original job only with the new Agent capability',async()=>{
 const job=await flatJob();await reportPublishing('pc',[{id:job.spec.id,revision:1,sequence:1,state:'needs_attention',videoId:'video_one',offset:0,total:job.spec.asset.size,updatedAt:Date.now()}]);
 await agentStore('pc').write('capabilities.json',['publishing-v1','publishing-consent-v2']);await expect(changePublishingJob(alice,job.spec.id,'repair',undefined,{playlistIds:[],thumbnailMode:'none'})).rejects.toMatchObject({code:'AGENT_VERSION'});
 await agentStore('pc').write('capabilities.json',['publishing-v1','publishing-consent-v2','publishing-recovery-v1']);
 const repaired=await changePublishingJob(alice,job.spec.id,'repair',undefined,{playlistIds:['valid_playlist'],thumbnailMode:'none'});expect(repaired.spec).toMatchObject({id:job.spec.id,repairRevision:2,revision:2,asset:job.spec.asset,profile:{channelId:job.spec.profile.channelId,playlistIds:['valid_playlist']}});expect(repaired.observed?.videoId).toBe('video_one');
});
it('F12 initial future uploads remain undispatched while pause and cancel are delivered',async()=>{
 const job=await flatJob(true);const moved=await changePublishingJob(alice,job.spec.id,'reschedule','2027-10-01T20:00:00Z');await publishingTick();expect((await publishingView(alice)).jobs[0].delivery).toBeUndefined();await changePublishingJob(alice,moved.spec.id,'pause');await publishingTick();expect((await publishingView(alice)).jobs[0].delivery?.revision).toBe(3);await changePublishingJob(alice,moved.spec.id,'cancel');await publishingTick();expect((await publishingView(alice)).jobs[0].delivery?.revision).toBe(4);
});

/** 失效后旧浏览器事务、旧register和较旧恢复代际都不能恢复新失效。 */
it('F01 fences late OAuth transactions and local registration with a Cloud epoch',async()=>{
 const account=await connected();const profile=await savePublishingProfile(alice,{...fixtureJob().profile,accountId:account.id});const batch=await previewPublishingBatch(alice,profile.id,[fixtureJob().asset.id]);const [job]=await confirmPublishingBatch(alice,batch.id,false,true);const old=await beginAuthorization(account.id);
 const report={id:job.spec.id,revision:1,sequence:1,state:'needs_attention' as const,authorizationInvalid:true,offset:0,total:job.spec.asset.size,updatedAt:Date.now()};await reportPublishing('pc',[report]);
 await claimPublishingAccount('pc',account.id,'main','channel_one','Synthetic',true,Date.now());await expect(finishRemoteOAuth(old.state,old.cookie,'alice','Synthetic old code',alice)).rejects.toMatchObject({code:'OAUTH_SUPERSEDED'});expect((await agentPublishingAccounts('pc'))[0].status).toBe('needs_reauthorization');
 const first=await beginAuthorization(account.id);const late=await beginAuthorization(account.id);await expect(finishRemoteOAuth(first.state,first.cookie,'alice','Synthetic first code',alice)).rejects.toMatchObject({code:'OAUTH_SUPERSEDED'});remote.rpc.mockResolvedValueOnce({ok:true});await finishRemoteOAuth(late.state,late.cookie,'alice','Synthetic newest code',alice);expect((await agentPublishingAccounts('pc'))[0].status).toBe('connected');
 const successfulFinish=remote.rpc.mock.calls.findLast(call=>call[2]?.kind==='publishing-account-oauth-finish')![2];const stale=await beginAuthorization(account.id);await reportPublishing('pc',[{...report,sequence:2,authorizationFailureId:randomUUID(),authorizationGeneration:successfulFinish.authorizationGeneration}]);await expect(finishRemoteOAuth(stale.state,stale.cookie,'alice','Synthetic stale code',alice)).rejects.toMatchObject({code:'OAUTH_SUPERSEDED'});expect((await agentPublishingAccounts('pc'))[0].status).toBe('needs_reauthorization');
 const failed=await beginAuthorization(account.id);remote.rpc.mockRejectedValueOnce(new Error('Synthetic lost Agent confirmation'));await expect(finishRemoteOAuth(failed.state,failed.cookie,'alice','Synthetic lost code',alice)).rejects.toBeDefined();expect((await agentPublishingAccounts('pc'))[0].status).toBe('needs_reauthorization');
 const retry=await beginAuthorization(account.id);remote.rpc.mockResolvedValueOnce({ok:true});await finishRemoteOAuth(retry.state,retry.cookie,'alice','Synthetic retry code',alice);expect((await agentPublishingAccounts('pc'))[0].status).toBe('connected');
});
/** legacy授权异常只保留任务为需要处理；不产生撤销或阻断同频道重新授权的清理记录。 */
it('F01 keeps legacy peer jobs and the reconnect path after an authorization failure',async()=>{
 const assets=[fixtureJob().asset,{...fixtureJob().asset,id:'e'.repeat(64),version:'f'.repeat(64),filename:'other.mp4'}];remote.rpc.mockResolvedValue({assets,thumbnails:[],channelId:'channel_one',channel:'Synthetic'});
 const profile=await savePublishingProfile(alice,fixtureJob().profile);const batch=await previewPublishingBatch(alice,profile.id,assets.map(asset=>asset.id));const jobs=await confirmPublishingBatch(alice,batch.id,false,true);await reportPublishing('pc',[{id:jobs[0].spec.id,revision:1,sequence:1,state:'needs_attention',authorizationInvalid:true,offset:0,total:jobs[0].spec.asset.size,updatedAt:Date.now()}]);
 const view=await publishingView(alice);expect(view.jobs).toHaveLength(2);expect(view.profiles).toHaveLength(1);expect(view.cleanups).toEqual([]);expect(view.jobs.find(job=>job.spec.id===jobs[1].spec.id)?.observed).toBeUndefined();await expect(changePublishingJob(alice,jobs[0].spec.id,'resume')).resolves.toMatchObject({spec:{id:jobs[0].spec.id,revision:2}});
});
it('F13 a repair sees an already-public video and does not change playlists or upload again',async()=>{
 const spec=fixtureJob();spec.profile.playlistIds=['deleted_playlist'];const storage=await checkpoint(spec,'needs_attention');const {api,videos}=fixtureApi();videos.set('video_one',{id:'video_one',snippet:{channelId:'channel_one'},status:{privacyStatus:'public'},processingDetails:{processingStatus:'succeeded'}});
 const runner=new PublishingRunner(new Map(),{store:storage,api:()=>api});await runner.apply({...spec,revision:2,repairRevision:2,profile:{...spec.profile,playlistIds:['replacement_playlist']}});await runner.tick();await settle(runner);expect((await runner.reports())[0]).toMatchObject({state:'published',videoId:'video_one'});expect(api.playlist).not.toHaveBeenCalled();expect(api.finalize).not.toHaveBeenCalled();expect(api.begin).not.toHaveBeenCalled();await runner.stop();
});
/** 持续needs状态也必须隔离每个新失效事件；相同sequence重传不制造新的恢复代际。 */
it('F01 advances the epoch for a new 401 while still waiting for reauthorization',async()=>{
 const account=await connected();const profile=await savePublishingProfile(alice,{...fixtureJob().profile,accountId:account.id});const batch=await previewPublishingBatch(alice,profile.id,[fixtureJob().asset.id]);const [job]=await confirmPublishingBatch(alice,batch.id,false,true);
 const report={id:job.spec.id,revision:1,sequence:1,state:'needs_attention' as const,authorizationInvalid:true,offset:0,total:job.spec.asset.size,updatedAt:Date.now()};await reportPublishing('pc',[report]);const old=await beginAuthorization(account.id);
 await reportPublishing('pc',[{...report,sequence:2}]);await expect(finishRemoteOAuth(old.state,old.cookie,'alice','Synthetic old code',alice)).rejects.toMatchObject({code:'OAUTH_SUPERSEDED'});expect((await agentPublishingAccounts('pc'))[0].status).toBe('needs_reauthorization');
 const retry=await beginAuthorization(account.id);await reportPublishing('pc',[{...report,sequence:2}]);remote.rpc.mockResolvedValueOnce({ok:true});await finishRemoteOAuth(retry.state,retry.cookie,'alice','Synthetic retry code',alice);expect((await agentPublishingAccounts('pc'))[0].status).toBe('connected');
});
