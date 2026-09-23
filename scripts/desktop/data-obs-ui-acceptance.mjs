/** 独立 OBS 产品流程 UI 验收；全部桥接状态为明确的合成数据。 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = path.resolve("desktop/out");
const output = path.resolve(process.env.LIVENEST_TEST_SCREENSHOTS || ".data/qa/managed-ui"); await mkdir(output, { recursive: true });
/** 仅托管构建输出，拒绝目录越界，不连接远程服务。 */
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, "." + new URL(request.url, "http://localhost").pathname.replace(/\/$/, "/index.html"));
    if (!filename.startsWith(root + path.sep)) throw new Error("Invalid path");
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
    response.setHeader("Content-Type", types[path.extname(filename)] || "application/octet-stream"); response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
 browser=await chromium.launch({channel:"msedge",headless:true});const page=await browser.newPage({viewport:{width:1280,height:880}});const errors=[];page.on("pageerror",error=>errors.push(error.message));
 /** 只模拟公开 DTO，不接触真实磁盘、Agent 或云端。 */
 await page.addInitScript(()=>{
  const state={version:"验收示例",dataRoot:"D:\\直播\\LiveNest",dataLocationReady:true,paired:false,agentRunning:false,online:false,autoStart:false,busy:false,instances:[],candidates:[],archivedCandidates:[],checks:[],snapshots:[],update:{status:"idle"}};
  window.fixture={state,calls:[],failNext:false};
  window.liveNest={session:async()=>({authenticated:true,username:"示例客户"}),logout:async()=>{},state:async()=>structuredClone(state),act:async(action,input)=>{
   window.fixture.calls.push({action,input});
   if(action==="add"){
    const n=state.instances.length+1;const item={id:n===1?"main":"obs_"+n,name:"OBS "+n,managed:true,exe:"D:/LiveNest/obs/"+n+"/bin/64bit/obs64.exe",port:4454+n,initialized:true};
    if(window.fixture.failNext){item.initialized=false;state.candidates.push(item);state.activity={action,instanceId:item.id,step:2,status:"failed",stage:"正在检查 OBS",message:"示例：连接未确认，候选已保留",startedAt:Date.now()};throw new Error(state.activity.message);}state.instances.push(item);
   }
   if(action==="prepare"){const candidate=state.candidates.find(i=>i.id===input.id);if(candidate){candidate.initialized=true;state.instances.push(candidate);state.candidates=state.candidates.filter(i=>i.id!==input.id);state.activity={...state.activity,status:"complete"};}}
   return structuredClone(state);
  }};
 });
 await page.goto("http://127.0.0.1:"+server.address().port);
 await page.getByRole("button",{name:"本机 OBS",exact:true}).click();
 await page.getByRole("button",{name:"准备第一个 OBS",exact:true}).waitFor();
 assert.equal(await page.getByRole("button",{name:"扫描电脑",exact:true}).isVisible(),false);
 await page.screenshot({path:path.join(output,"first-obs-synthetic.png"),fullPage:true});
 await page.getByRole("button",{name:"准备第一个 OBS",exact:true}).click();
 await page.getByRole("heading",{name:"OBS 1",exact:true}).waitFor();
 await page.getByRole("button",{name:"+ 添加 OBS",exact:true}).click();await page.getByRole("button",{name:"+ 添加 OBS",exact:true}).click();
 for(const n of [1,2,3])await page.getByRole("heading",{name:"OBS "+n,exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.map(c=>c.action)),["add","add","add"]);
 assert.equal(await page.getByText("端口 4455",{exact:true}).isVisible(),false);
 await page.screenshot({path:path.join(output,"three-obs-synthetic.png"),fullPage:true});
 await page.setViewportSize({width:800,height:750});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(output,"three-obs-narrow-synthetic.png"),fullPage:true});
 await page.evaluate(()=>{window.fixture.failNext=true;});await page.getByRole("button",{name:"+ 添加 OBS",exact:true}).click();
 await page.getByRole("heading",{name:"待配置 OBS",exact:true}).waitFor();await page.getByRole("button",{name:"重试配置",exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.at(-1)),{action:"prepare",input:{id:"obs_4"}});
 await page.getByRole("button",{name:"设置",exact:true}).click();await page.getByRole("heading",{name:"LiveNest 数据位置",exact:true}).waitFor();
 await page.getByRole("button",{name:"打开文件夹",exact:true}).click();await page.getByRole("button",{name:"更改位置",exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.slice(-2).map(c=>c.action)),["open-data","directory"]);
 await page.screenshot({path:path.join(output,"data-location-synthetic.png"),fullPage:true});assert.deepEqual(errors,[]);
 console.log("Managed OBS UI passed: first/create/add, collapsed advanced options, targeted retry, data location, narrow layout.");
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
