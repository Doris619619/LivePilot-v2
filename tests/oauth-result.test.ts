/** 短期 OAuth 结果按原账号和当前设备权限读取，使用隔离临时目录。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveOAuthResult, readOAuthResult } from "../src/server/oauth-result";
import { authorizeAgent } from "../src/server/ownership";
import { AppError } from "../src/core/errors";
vi.mock("../src/server/ownership",()=>({authorizeAgent:vi.fn(async()=>({}))}));
let root:string;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),"livenest-oauth-result-"));vi.stubEnv("LIVEPILOT_DATA_ROOT",root);vi.mocked(authorizeAgent).mockReset();});
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith("livenest-oauth-result-"))throw Error("Unsafe cleanup");await rm(root,{recursive:true,force:true});});
it("preserves the original target across reloads without allowing another account",async()=>{const result={target:{agentId:"pc_a",instanceId:"obs_b"},status:"cancelled" as const};const id=await saveOAuthResult("alice",result);expect(id).not.toContain("obs_b");expect(await readOAuthResult(id,{username:"alice",role:"customer"})).toEqual(result);await expect(readOAuthResult(id,{username:"bob",role:"admin"})).rejects.toMatchObject({status:404});expect(authorizeAgent).toHaveBeenCalledOnce();});
it("rechecks device ownership after the original callback",async()=>{const id=await saveOAuthResult("alice",{target:{agentId:"pc_a",instanceId:"obs_b"},status:"connected"});vi.mocked(authorizeAgent).mockRejectedValue(new AppError("FORBIDDEN","归属已改变",403));await expect(readOAuthResult(id,{username:"alice",role:"customer"})).rejects.toMatchObject({status:403});});
it("expires notices without repeating an authorization operation",async()=>{const id=await saveOAuthResult("alice",{target:{instanceId:"main"},status:"connected"});vi.useFakeTimers();vi.setSystemTime(Date.now()+600001);await expect(readOAuthResult(id,{username:"alice",role:"customer"})).rejects.toMatchObject({status:410});});
