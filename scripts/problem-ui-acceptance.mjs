/** 客户故障界面验收：隔离目录、合成响应与桌面桥接，绝不调用真实控制或授权。 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root=await mkdtemp(path.join(os.tmpdir(),'livenest-problem-ui-'));
const output=path.resolve('docs/desktop/screenshots/problems');await mkdir(output,{recursive:true});
const origin='http://127.0.0.1:3426';
const next=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3426'],{env:{...process.env,LIVEPILOT_ORIGIN:origin,LIVEPILOT_DATA_ROOT:root,LIVEPILOT_ACCESS_DIR:path.join(root,'access')},windowsHide:true,stdio:'ignore'});
const staticRoot=path.resolve('desktop/out');
/** 托管本次桌面构建且拒绝路径穿越。 */
const desktop=createServer(async(req,res)=>{try{const file=path.resolve(staticRoot,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));if(!file.startsWith(staticRoot+path.sep))throw Error();res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>desktop.listen(0,'127.0.0.1',r));let browser;
/** 所有截图直接标记模拟故障，不作为真实广播或账户证据。 */
async function capture(page,name){await page.evaluate(()=>{let label=document.getElementById('fixture-label');if(!label){label=document.createElement('div');label.id='fixture-label';label.textContent='模拟故障 · 隔离验收数据';label.style.cssText='position:relative;background:#253a2b;color:white;padding:6px 12px;z-index:9999;font-size:14px';document.body.prepend(label);}});await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' horizontal overflow');}
/** 固定版本契约夹具，消息不含真实路径或身份。 */
const problem=(code,message,domain='obs')=>({version:1,source:"core",code,message,domain,target:{agentId:'fixture_pc',instanceId:'obs_b'},severity:'error',stage:'读取 OBS 状态',outcome:'unknown',observedAt:Date.now(),actions:['refresh','settings']});
try{
 for(let i=0;i<80;i++){try{if((await fetch(origin)).ok)break;}catch{}if(next.exitCode!==null)throw Error('Preview failed');await new Promise(r=>setTimeout(r,250));}
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));const writes=[];const reads=[];
 const p=problem('OBS_NOT_LISTENING','OBS 已运行，但端口 4455 未检测到控制服务。实际推流状态需要核对。');
 const upload={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',instanceId:'obs_b',agentId:'fixture_pc',kind:'videos',filename:'模拟故障视频.mp4',size:32,received:32,chunkSize:32,fingerprint:'a'.repeat(64),status:'verifying',verification:'failed',expiresAt:Date.now()+60000,error:'文件已传完，但校验未通过。',problem:{...problem('UPLOAD','文件校验未通过。','media'),actions:['refresh']}};
 await page.addInitScript(value=>localStorage.setItem('livepilot-upload',JSON.stringify(value)),upload);
 await page.route('**/api/**',async route=>{const req=route.request();const url=new URL(req.url());if(req.method()!=='GET')writes.push({path:url.pathname,body:req.postData()});let body={};
  if(url.pathname==='/api/session')body={user:{username:'模拟客户',role:'customer'}};
  else if(url.pathname==='/api/instances')body={instances:[{id:'obs_b',name:'OBS 2',agentId:'fixture_pc',agentName:'模拟电脑 A'}],agents:[{id:'fixture_pc',name:'模拟电脑 A',online:true,owner:'模拟客户'}]};
  else if(url.pathname==='/api/status'){reads.push(url.searchParams.get('instanceId'));body={busy:false,state:{phase:'idle',stage:'等待开始'},obs:{ready:false,running:true,processKnown:true,streaming:null,problem:p},youtube:{connected:true,channel:'模拟频道',authorization:'present',query:'ready'},media:{videos:[],music:['模拟音乐.mp3'],error:'视频目录暂不可读',problems:[{...problem('STORAGE_PERMISSION','视频目录暂不可读','media'),stage:'读取视频目录'}]},configuration:{missing:[],privacy:'unlisted'}};}
  else if(url.pathname==='/api/uploads')body=[upload];else if(url.pathname.startsWith('/api/uploads/'))body=upload;
  else if(url.pathname==='/api/youtube/result')body={target:p.target,status:'cancelled'};
  else throw Error('Unexpected fixture API '+url.pathname);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(origin+'/workspace?oauthResult=fixture#instance-fixture_pc-obs_b');
 const card=page.locator('.instance-card');await card.getByText('控制连接尚未建立',{exact:false}).waitFor();
 assert.equal(await page.getByText('还没有视频，添加后即可选择。',{exact:true}).count(),0);
 await page.getByRole('button',{name:'收起上传',exact:true}).click();await page.getByRole('button',{name:'查看进度与处理步骤'}).waitFor();
 await card.getByRole('button',{name:'收起详情',exact:true}).press('Enter');assert.equal(await card.getByRole('alert').count(),2);
 await card.getByRole('button',{name:'重新检查',exact:true}).first().press('Enter');assert.ok(reads.every(id=>id==='obs_b'));assert.deepEqual(writes,[]);
 await capture(page,'web-collapsed');await page.setViewportSize({width:390,height:844});await capture(page,'web-390');
 await page.getByRole('button',{name:'查看进度与处理步骤'}).click();await page.getByRole('button',{name:'查询校验状态'}).click();assert.deepEqual(writes,[]);await page.getByRole('button',{name:'重新提交校验'}).waitFor();await capture(page,'upload-failed-390');
 const desktopPage=await browser.newPage({viewport:{width:780,height:850}});desktopPage.on('pageerror',e=>errors.push(e.message));
 await desktopPage.addInitScript(p=>{const candidate={id:'obs_b',name:'OBS 2',port:4455,initialized:false,managed:false,exe:'C:/Synthetic/obs64.exe'};const state={version:'模拟故障',dataRoot:'C:/Synthetic',instances:[],candidates:[candidate],checks:[],snapshots:[],online:false,paired:false,busy:false,autoStart:false,update:{status:'idle'}};window.fixture={calls:[],state};window.liveNest={session:async()=>({authenticated:true,username:'模拟客户'}),state:async()=>structuredClone(state),act:async(action,input)=>{window.fixture.calls.push({action,id:input?.id});if(action==='repair'){state.activity={action,instanceId:input.id,step:2,status:'failed',stage:'检查原 OBS',message:p.message,problem:p,startedAt:Date.now()};return {ok:false,problem:{...p,attemptId:'original-attempt'}};}return{ok:true,state:structuredClone(state)};}};},p);
 await desktopPage.goto('http://127.0.0.1:'+desktop.address().port);await desktopPage.getByRole('button',{name:'修正手动 OBS 连接'}).click();await desktopPage.getByLabel('WebSocket 密码',{exact:true}).first().fill('synthetic-input');await desktopPage.getByRole('button',{name:'保存并检查'}).click();await desktopPage.getByRole('button',{name:'查询本次操作'}).waitFor();assert.equal(await desktopPage.getByLabel('WebSocket 密码',{exact:true}).first().inputValue(),'synthetic-input');
 await capture(desktopPage,'desktop-780');await desktopPage.getByRole('button',{name:'查询本次操作'}).press('Enter');assert.deepEqual(await desktopPage.evaluate(()=>window.fixture.calls),[{action:'repair',id:'obs_b'},{action:'diagnose-obs',id:'obs_b'}]);
 assert.deepEqual(errors,[]);console.log('PASS: collapsed errors, original target, read-only recovery, upload query, preserved form, keyboard and 780/390px layout.');
}finally{await browser?.close();next.kill();await new Promise(r=>desktop.close(r));if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('livenest-problem-ui-'))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
