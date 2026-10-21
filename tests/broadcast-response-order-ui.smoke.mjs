/** 正式Hook和InstanceConsole的乱序/停止回归：Edge与隔离HTTP，控制仅记录合成payload，不访问设备。 */
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const repo=process.cwd(), dir=await mkdtemp(path.join(tmpdir(),"livepilot-response-ui-"));
const entry=`import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {useInstance} from './src/app/use-instance';import Console from './src/app/instance-console';function App(){const m=useInstance({id:'main',name:'Synthetic',agentId:'pc'});useEffect(()=>{window.model=m});return <select id="video" value={m.selection.video} onChange={e=>m.select({video:e.target.value})}><option>first.mp4</option><option>second.mp4</option></select>}createRoot(document.getElementById('root')).render(location.pathname==='/console'?<Console instance={{id:'main',name:'Synthetic',agentId:'pc'}} onChannelChange={()=>{}} onUpload={()=>{}}/>:<App/>);`;
await build({stdin:{contents:entry,resolveDir:repo,loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:path.join(dir,'ui.js'),alias:{'@':path.join(repo,'src')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const js=await readFile(path.join(dir,'ui.js'));
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/ui.js'?'text/javascript':'text/html');res.end(req.url==='/ui.js'?js:'<div id="root"></div><script src="/ui.js"></script>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
/** 创建带实际观测时间的合成旧场次/已结束状态。 */
function data(phase='live',at=Date.now(),bid='first') {return {busy:false,device:{agentId:'pc',name:'Synthetic',online:true,lastSeen:at,observedAt:at},state:{phase,stage:'Synthetic',updatedAt:new Date(at).toISOString(),broadcastId:bid,broadcastTitle:'Synthetic',channelId:'channel',obsStartRequested:phase==='live',selection:{video:'first.mp4',music:'first.mp3',videoAudio:false,broadcast:{title:'Synthetic',description:'',privacy:'private',madeForKids:false,playlistIds:[]}}},obs:{ready:true,running:true,streaming:phase==='live',durationMs:120000},youtube:{connected:true,query:'ready',channel:'Synthetic channel',channelId:'channel',lifecycle:phase==='live'?'live':'complete',ingest:'active',checkedAt:new Date(at).toISOString()},media:{videos:['first.mp4','second.mp4'],music:['first.mp3']},configuration:{youtubeRefresh:true,missing:[],privacy:'private',madeForKids:false}}}
let browser;
try {browser=await chromium.launch({channel:'msedge',headless:true});
  for(const old of ['success','error','new-bid','local-no-time']){
    const page=await browser.newPage();let state=data(),held,hold=false,payload;
    await page.route('**/api/status?**',route=>{if(hold&&route.request().method()==='GET'){hold=false;held=route;return;}return route.fulfill({json:state});});
    await page.route('**/api/control',route=>{payload=route.request().postDataJSON();return route.fulfill({json:{ok:true}})});
    await page.goto(origin);await page.waitForFunction(()=>window.model?.data);
    hold=true;await page.evaluate(()=>{window.pending=window.model.refresh()});await page.waitForFunction(()=>!!window.pending);while(!held)await new Promise(r=>setTimeout(r,10));
    state=data('stopped',Date.now()+10);if(old==='local-no-time')delete state.device;
    await page.evaluate(()=>window.model.checkPlatform());await page.selectOption('#video','second.mp4');
    const response=data('live',Date.now()-1000,old==='new-bid'?'another':'first');if(old==='local-no-time')delete response.device;
    if(old==='error')await held.fulfill({status:503,json:{error:'late read failure'}});else await held.fulfill({json:response});
    await page.evaluate(()=>window.pending);
    assert.equal(await page.inputValue('#video'),'second.mp4');assert.equal(await page.evaluate(()=>window.model.stale),false);
    await page.evaluate(()=>window.model.act('start'));assert.equal(payload.video,'second.mp4');assert.equal(payload.action,'start');
    await page.close();console.log(`V01 ${old}: accepted stopped state and actual second-session payload preserved`);
  }
  for(const outcome of ['success','error','timeout']){
    const page=await browser.newPage();let state=data(),held,stopResolve,stops=0;
    await page.route('**/api/status?**',route=>{if(route.request().method()==='POST'){held=route;return;}return route.fulfill({json:state})});
    await page.route('**/api/control',async route=>{assert.equal(route.request().postDataJSON().action,'stop');stops++;await new Promise(r=>stopResolve=r);state=data('stopped',Date.now()+20);await route.fulfill({json:{ok:true}})});
    await page.goto(origin+'/console');await page.getByRole('button',{name:'查看运行状态',exact:true}).click();
    const stop=page.getByRole('button',{name:'结束直播',exact:true});assert.equal(await stop.isEnabled(),true);
    await page.getByRole('button',{name:'重新检查状态',exact:true}).click();while(!held)await new Promise(r=>setTimeout(r,10));
    assert.equal(await stop.isEnabled(),true);await stop.click();while(!stopResolve)await new Promise(r=>setTimeout(r,10));
    assert.equal(stops,1);assert.equal(await page.getByRole('button',{name:'结束中…',exact:true}).count()>0,true);stopResolve();
    await page.getByRole('button',{name:'开始直播',exact:true}).waitFor();
    if(outcome==='success')await held.fulfill({json:data('live',Date.now()-1000)}).catch(()=>{});
    else if(outcome==='error')await held.fulfill({status:503,json:{error:'late platform failure'}}).catch(()=>{});else await held.abort('timedout').catch(()=>{});
    await page.waitForTimeout(50);assert.equal(await page.getByText('本场已结束',{exact:true}).count()>0,true);assert.equal(await page.getByText('late platform failure',{exact:false}).count(),0);
    await page.close();console.log(`V04 ${outcome}: stop preempts manual read; late result ignored`);
  }
} finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));const rel=path.relative(tmpdir(),dir);if(rel.startsWith('..')||path.isAbsolute(rel)||!path.basename(dir).startsWith('livepilot-response-ui-'))throw Error('unsafe cleanup');await rm(dir,{recursive:true,force:true});}
