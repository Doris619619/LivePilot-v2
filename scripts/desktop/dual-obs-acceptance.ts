/** 隔离 Windows 双 OBS 实测，只推送 127.0.0.1 接收端。 */
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn,execFile as execCb} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {newInstance,initializeObs,freePort} from '../../electron/obs-setup';
import {environment, type Settings} from '../../electron/settings';
import {configureCore,config} from '../../src/core/config';
import {ObsController} from '../../src/core/obs/controller';
import {ObsProcessManager} from '../../src/core/obs/process';
import {ObsDiscovery,inspectObs} from '../../electron/obs-discovery';
const exec=promisify(execCb);const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
void (async()=>{
const root=path.resolve('.data/qa/dual-'+Date.now());await mkdir(root,{recursive:true});
const settings:Settings={dataRoot:root,instances:[],encryptionKey:'a'.repeat(64)};
const resources=path.resolve('desktop-resources');const ffmpeg=process.env.QA_FFMPEG!;
const controllers:ObsController[]=[];const receivers:ReturnType<typeof spawn>[]=[];
const results:{root:string;publicBroadcast:boolean;steps:{instance:string;version:string;port:number;validated:boolean}[];discovery?:{version:string;attached:boolean}[];concurrent?:unknown[];independentStop?:boolean;independentExit?:boolean;restart?:boolean;mediaIsolation?:boolean;result?:string;error?:string}={root,publicBroadcast:false,steps:[]};
/** 等待真实状态，超时保留失败证据。 */
async function until(check:()=>Promise<boolean>,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(500);}throw new Error('State wait timed out');}
try{
 for(let n=0;n<2;n++){const i=await newInstance(settings);i.port=await freePort(settings.instances.map(v=>v.port),14455);i.name='QA OBS '+(n+1);settings.instances.push(i);await initializeObs(settings,i,resources,s=>console.log(i.name+': '+s));i.initialized=true;}
 configureCore(()=>environment(settings));
 for(const i of settings.instances){const c=new ObsController(()=>config(i.id));controllers.push(c);await c.validate();const metadata=await inspectObs(i.exe);results.steps.push({instance:i.name,version:metadata.version,port:i.port,validated:true});}
 const discovery=new ObsDiscovery();await discovery.walk(root,settings.instances.map(i=>i.exe));if(discovery.state.results.length!==2||discovery.state.results.some(c=>c.error))throw new Error('Discovery failed');results.discovery=discovery.state.results.map(c=>({version:c.version,attached:c.attached}));
 for(let n=0;n<2;n++){
  const dir=path.join(root,'media-'+n);await mkdir(dir,{recursive:true});
  await exec(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${n?'blue':'red'}:s=320x180:r=15`,'-t','15','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,'video.mp4')],{windowsHide:true});
  await exec(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i',`sine=frequency=${n?880:440}:sample_rate=48000`,'-t','15',path.join(dir,'music.wav')],{windowsHide:true});
  await controllers[n].configureMedia(path.join(dir,'video.mp4'),path.join(dir,'music.wav'),false);
  const port=await freePort([],19355+n);const receiver=spawn(ffmpeg,['-hide_banner','-loglevel','error','-listen','1','-i',`rtmp://127.0.0.1:${port}/live/fixture`,'-c','copy',path.join(dir,'received.flv')],{windowsHide:true,stdio:'ignore'});receivers.push(receiver);await sleep(800);
  await controllers[n].call('SetStreamServiceSettings',{streamServiceType:'rtmp_custom',streamServiceSettings:{server:`rtmp://127.0.0.1:${port}/live`,key:'fixture',use_auth:false}});await controllers[n].call('StartStream');
 }
 await until(async()=> (await Promise.all(controllers.map(c=>c.call('GetStreamStatus')))).every(s=>s.outputActive&&s.outputBytes>0));await sleep(6000);
 results.concurrent=await Promise.all(controllers.map(c=>c.call('GetStreamStatus')));console.log('Both OBS streaming to loopback.');
 await controllers[1].call('StopStream');await until(async()=>!(await controllers[1].call('GetStreamStatus')).outputActive);if(!(await controllers[0].call('GetStreamStatus')).outputActive)throw new Error('First OBS interrupted');results.independentStop=true;
 const second=settings.instances[1];await controllers[1].disconnect();const p=await new ObsProcessManager(()=>config(second.id)).inspect();if(!p.pid)throw new Error('Missing owned PID');await exec('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true});await sleep(1000);
 if(!(await controllers[0].call('GetStreamStatus')).outputActive)throw new Error('First OBS interrupted after second exit');results.independentExit=true;
 await initializeObs(settings,second,resources);await controllers[1].validate();results.restart=true;
 const input=await controllers[0].call('GetInputSettings',{inputName:'VIDEO'});if(!String(input.inputSettings.local_file).includes('media-0'))throw new Error('Media routing changed');results.mediaIsolation=true;
 results.result='passed';
} catch(e){results.result='failed';results.error=e instanceof Error?e.message:'Unknown';process.exitCode=1;}
finally{
 for(let n=0;n<controllers.length;n++){const c=controllers[n];try{if((await c.call('GetStreamStatus')).outputActive)await c.call('StopStream');await until(async()=>!(await c.call('GetStreamStatus')).outputActive,10000);const p=await new ObsProcessManager(()=>config(settings.instances[n].id)).inspect();await c.disconnect();if(p.pid)await exec('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true});}catch{await c.disconnect();}}
 for(const r of receivers)if(r.exitCode===null)r.kill();
 await writeFile(path.join(root,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({result:results.result,error:results.error,artifact:path.join(root,'result.json')}));
}

})().catch(e=>{console.error(e.message);process.exitCode=1;});
