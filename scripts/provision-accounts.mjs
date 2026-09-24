/** 一次性账号初始化：凭据仅从标准输入读取，不接受命令行明文，不重置已存在的密码。 */
import { readFile, mkdir, writeFile, rename, open, unlink } from "node:fs/promises";
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
if(process.env.LIVEPILOT_ENV_FILE)process.loadEnvFile(process.env.LIVEPILOT_ENV_FILE);
const roles={Do:"customer",Liang:"customer",ULiang:"admin",UDo:"admin"};
const dir=path.resolve(process.env.LIVEPILOT_ACCESS_DIR||path.join(process.env.LIVEPILOT_DATA_ROOT||".data","access"));
let input="";for await(const part of process.stdin){input+=part;if(input.length>4096)throw new Error("Input too large");}
let passwords;try{passwords=JSON.parse(input);}catch{throw new Error("请通过标准输入提供账号密码 JSON，禁止写入版本库。");}
for(const name of Object.keys(roles))if(typeof passwords[name]!=="string"||passwords[name].length<8||passwords[name].length>256)throw new Error("初始化密码长度必须为 8–256 位。");
await mkdir(dir,{recursive:true});const lock=path.join(dir,"access.lock");const handle=await open(lock,"wx",0o600);
try{
 await handle.writeFile(String(process.pid));const filename=path.join(dir,"access.json");let state;
 try{state=JSON.parse(await readFile(filename,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;state={users:[],sessions:{},attempts:{}};}
 for(const [username,role] of Object.entries(roles)){
  let user=state.users.find(u=>u.username===username);let changed=false;
  if(!user){const salt=randomBytes(16).toString("hex");const hash=(await promisify(scrypt)(passwords[username],salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString("hex");user={username,salt,hash,disabled:false};state.users.push(user);changed=true;}
  if(user.role!==role){user.role=role;changed=true;}
  if(changed){user.revision=randomBytes(16).toString("hex");state.sessions=Object.fromEntries(Object.entries(state.sessions).filter(([,s])=>s.username!==username));}
 }
 const temp=filename+"."+randomBytes(8).toString("hex")+".tmp";await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,filename);
 console.log("账号初始化完成；已存在的密码与禁用状态保持不变。旧设备等待管理员分配。");
}finally{await handle.close();await unlink(lock);}
