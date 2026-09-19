/** 使用临时网页与模拟 API 验证上传布局、目标选择及下载页；禁止真实开播或生产写入。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const root=await mkdtemp(path.join(os.tmpdir(),'ln-upload-ui-'));
const probe=createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const output=path.resolve(process.env.LIVENEST_TEST_SCREENSHOTS || 'test-results/upload-ui'); await mkdir(output,{recursive:true});
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{windowsHide:true,env:{...process.env,LIVEPILOT_MODE:'cloud',LIVEPILOT_ORIGIN:origin,LIVEPILOT_DATA_ROOT:root},stdio:'ignore'});
const exited=new Promise(r=>child.once('exit',r)); let browser; let release;
try {
 for(let n=0;n<100;n++){try{if((await fetch(origin)).ok)break;}catch{} await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({channel:'msedge',headless:true}); const page=await browser.newPage({viewport:{width:1280,height:820}}); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const instances=[{id:'main',name:'主 OBS',agentId:'studio',agentName:'工作室电脑'},{id:'obs_b',name:'OBS 2',agentId:'studio',agentName:'工作室电脑'}];
 let record; let uploaded=false; let withMedia=false; let empty=false; const creates=[];
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()); const method=route.request().method(); let body;
  if(url.pathname==='/api/session') body={user:{username:'示例账号'}};
  else if(url.pathname==='/api/instances') body={instances,agents:[{id:'studio',name:'工作室电脑',online:true,paired:true,revoked:false,instances}]};
  else if(url.pathname==='/api/status') body={device:{agentId:'studio',name:'工作室电脑',online:true,lastSeen:Date.now(),observedAt:Date.now()},state:{phase:'idle',stage:'等待开始',updatedAt:new Date().toISOString()},busy:false,obs:{ready:true,running:true,streaming:false},youtube:{connected:true,channel:url.searchParams.get('instanceId')==='main'?'慢时光电台':'城市漫游'},media:{videos:withMedia?['雨夜漫游.mp4']:(uploaded?['示例视频.mp4']:[]),music:withMedia?['午后爵士.mp3']:[]},configuration:{missing:[],privacy:'unlisted',madeForKids:false}};
  else if(url.pathname==='/api/uploads'&&method==='GET') body=empty?[]:[{id:'older',agentId:'studio',instanceId:url.searchParams.get('instanceId'),filename:'上次未完成的视频.mp4',message:'上传已暂停，可继续'}];
  else if(url.pathname==='/api/uploads'&&method==='POST'){const value=route.request().postDataJSON();creates.push(value);record={...value,id:value.requestId,status:'uploading',received:0};body=record;}
  else if(url.pathname.startsWith('/api/uploads/')&&method==='PUT'){await new Promise(r=>{release=r;}); record={...record,received:record.size};body=record;}
  else if(url.pathname.endsWith('/complete')){uploaded=true;body=record={...record,status:'complete',publishedName:record.filename};}
  else if(url.pathname.startsWith('/api/uploads/')&&method==='GET')body=record;
  else if(url.pathname.startsWith('/api/uploads/')&&method==='DELETE')body={ok:true};
  else throw new Error('Unexpected API '+method+' '+url.pathname);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(origin); await page.getByRole('button',{name:'添加视频',exact:true}).nth(1).click();
 assert.equal(await page.locator('#upload-instance').inputValue(),'studio:obs_b'); assert.equal(await page.locator('#upload-kind').inputValue(),'videos');
 await page.locator('#upload-file').setInputFiles({name:'示例视频.mp4',mimeType:'video/mp4',buffer:Buffer.alloc(4 * 1024 * 1024)});
 await page.getByRole('button',{name:'开始上传',exact:true}).click(); await page.getByRole('button',{name:'暂停上传',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'传输中…',exact:true}).count(),0);
 await page.locator('.upload-recovery summary').click(); assert.equal(await page.getByRole('button',{name:'查询未结束的上传'}).isDisabled(),true); await page.locator('.upload-recovery summary').click();
 await page.getByRole('button',{name:'添加音乐',exact:true}).first().click(); await page.getByText('已保留当前上传，请先完成或取消，再添加到其他 OBS。').waitFor();
 assert.equal(creates.length,1); assert.equal(creates[0].instanceId,'obs_b'); assert.equal(creates[0].kind,'videos');
 await page.screenshot({animations:'disabled',path:path.join(output,'upload-progress.png')});
 for(const width of [800,390]) {await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({animations:'disabled',path:path.join(output,'upload-'+width+'.png')});}
 for(let n=0;n<80&&!release;n++)await new Promise(r=>setTimeout(r,50)); assert.ok(release);release();release=undefined;
 await page.getByText('已添加到素材库，可回到下方选择使用。').waitFor(); await page.getByRole('button',{name:'上传下一个',exact:true}).click();
 assert.equal(await page.locator('#upload-instance').inputValue(),'studio:obs_b');
 withMedia=true; empty=true; await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();}); await page.setViewportSize({width:1280,height:820});await page.reload(); await page.getByText('慢时光电台',{exact:true}).first().waitFor();
 await page.evaluate(async()=>{await document.fonts.ready;scrollTo(0,0);});
 await page.screenshot({animations:'disabled',path:path.resolve('public/download/workspace.png')});
 await page.goto(origin+'/download'); await page.getByRole('heading',{level:1}).waitFor();
 assert.equal(await page.getByRole('link',{name:'下载 Windows 版'}).getAttribute('href'),'/downloads/0.1.1/LiveNest_0.1.1_x64-setup.exe');
 for(const width of [1440,800,390]){await page.setViewportSize({width,height:900});await page.screenshot({animations:'disabled',path:path.join(output,'download-'+width+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.getByText('如何核对安装包？',{exact:true}).click(); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.emulateMedia({reducedMotion:'reduce'}); assert.equal(await page.locator('.download-copy').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.reload(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'跳转到下载内容');
 assert.deepEqual(errors,[]);console.log('Upload/download UI passed: correct OBS target, empty media CTA, preserved active upload, recovery disabled during transfer, completion, responsive 390/800/1440px and public download page. Mock API only.');
}finally{release?.();await browser?.close();if(child.exitCode===null)child.kill();await exited;}
