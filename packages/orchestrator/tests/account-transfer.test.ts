import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { CodexMeterSampler } from "../src/meters-codex.js";
import { AccountTransfer, type TransferPacket } from "../src/auth/account-transfer.js";
import { SharedOAuthAuth, dropLocalCredential, oauthCredential, transactSharedCredential } from "../src/auth/shared-oauth.js";

const credential = (account = "provider-account", suffix = "original") => ({type:"oauth",access:`head.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:account}})).toString("base64url")}.${suffix}`,refresh:`refresh-${suffix}`,accountId:account,expires:Date.now()+3600000});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"account-transfer-")),source=Store.open(join(dir,"source.db")),target=Store.open(join(dir,"target.db"));
  const sourceAuth=join(dir,"source-auth.json"),targetAuth=join(dir,"target-auth.json");
  writeFileSync(sourceAuth,JSON.stringify({"openai-codex-12":credential()}));writeFileSync(targetAuth,"{}");
  for(const id of ["openai-codex-12","keep-a","keep-b"]){source.upsertAccount({id,provider:"openai-codex",concurrency:4,label:"account label"});for(const meter of ["codex-5h","codex-7d"])source.recordMeter(id,meter,82,Date.now()+86400000,Date.now());}
  source.recordUsage({accountId:"openai-codex-12",hour:1,source:"pi",runId:"historical",model:"gpt-6-astra",component:"output",tokens:123});
  source.createLease("past","openai-codex-12","interactive",undefined,1);source.endLease("past",100);
  const probe={reads:0,spent:82,fail:false};
  const from=new AccountTransfer(source,sourceAuth,{host:"source",ledger:"/source.db"},async alias=>{
    probe.reads++;
    expect(source.account(alias)?.enabled).toBe(false);
    if(probe.fail)throw new Error("provider unavailable");
    for(const meter of source.latestMeters(alias))source.recordMeter(alias,meter.meter_id,probe.spent,meter.reset_at,Math.max(Date.now(),meter.observed_at+1));
  }),to=new AccountTransfer(target,targetAuth,{host:"target",ledger:"/target.db"});
  return {source,target,from,to,probe,sourceAuth,targetAuth,signal:AbortSignal.timeout(5000),close(){source.close();target.close();rmSync(dir,{recursive:true,force:true});}};
}

describe("exclusive account transfer",()=>{
  it("explicit owning sampler reads a disabled account without changing admission",async()=>{
    const f=fixture();try{
      f.source.setAccountEnabled("openai-codex-12",false);
      const auth=new SharedOAuthAuth({path:f.sourceAuth,providerId:"openai-codex",refresh:async value=>value,toAuth:async value=>({apiKey:value.access})});
      const requests:string[]=[];
      const sampler=new CodexMeterSampler(f.source,{auth,meters:[{id:"codex-5h",windowHours:5},{id:"codex-7d",windowHours:168}],fetch:async url=>{
        requests.push(String(url));
        return Response.json({rate_limit:{primary_window:{used_percent:21,limit_window_seconds:18000,reset_at:(Date.now()+3600000)/1000},secondary_window:{used_percent:91,limit_window_seconds:604800,reset_at:(Date.now()+86400000)/1000}}});
      }});
      expect((await sampler.sample()).filter(row=>row.accountId==="openai-codex-12")).toEqual([]);
      expect(requests).toHaveLength(0);
      const result=await sampler.sampleAccount("openai-codex-12");
      expect(result.map(row=>[row.meterId,row.outcome,row.usedPercent])).toEqual([["codex-5h","recorded",21],["codex-7d","recorded",91]]);
      expect(requests).toHaveLength(1);expect(requests[0]).toContain("/codex/usage");
      expect(f.source.account("openai-codex-12")?.enabled).toBe(false);
    }finally{f.close();}
  });
  it("moves identity and quota history with one usable credential owner, preserving source history",async()=>{
    const f=fixture();try{
      const reservation='{"metadata":{"purpose":"regulatory-atlas-tagging"},"reason":"Atlas highest priority"}';
      f.target.setControl("account-reservation:openai-codex-12",reservation);
      f.source.setControl("account-reservation:openai-codex-12",'{"metadata":{"purpose":"source-only"},"reason":"source reservation"}');
      const destination=await f.to.inspect("openai-codex-12",f.signal);
      const packet=await f.from.prepare("openai-codex-12",destination,f.signal) as TransferPacket;
      expect(f.source.account(packet.alias)?.enabled).toBe(false);
      expect(()=>f.source.setAccountEnabled(packet.alias,true)).toThrow("source cannot enable");
      expect(oauthCredential(JSON.parse(readFileSync(f.sourceAuth,"utf8"))[packet.alias])).toBeUndefined();
      expect(f.target.account(packet.alias)).toBeUndefined();
      const accepted=await f.to.receive(packet,f.signal);
      expect(f.target.account(packet.alias)).toMatchObject({enabled:true,concurrency:4,label:"account label"});
      expect(f.target.control("account-reservation:openai-codex-12")).toBe(reservation);
      expect(f.target.meters(packet.alias)).toEqual(f.source.meters(packet.alias));
      expect(f.target.usageSince(0)).toEqual(f.source.usageSince(0));
      expect(f.target.db.prepare("SELECT * FROM lease").all()).toEqual(f.source.db.prepare("SELECT * FROM lease").all());
      await f.from.finish(packet.alias,accepted,f.signal);
      expect(JSON.stringify(await f.from.outgoing(packet.alias,f.signal))).not.toContain("refresh-original");
      await expect(transactSharedCredential(f.sourceAuth,packet.alias,credential(),async()=>{})).rejects.toThrow("exclusive transfer");
    }finally{f.close();}
  });

  it("lost acknowledgement replays a receipt without replacing destination's rotated token",async()=>{
    const f=fixture();try{
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      const accepted=await f.to.receive(packet,f.signal);
      await transactSharedCredential(f.targetAuth,packet.alias,credential("provider-account","rotated"),async()=>{});
      const replay=await f.from.prepare(packet.alias,f.to.endpoint,f.signal);
      expect(replay).toEqual(packet);
      expect(await f.to.receive(replay as TransferPacket,f.signal)).toEqual(accepted);
      expect(JSON.parse(readFileSync(f.targetAuth,"utf8"))[packet.alias].refresh).toBe("refresh-rotated");
      expect(f.target.usageSince(0)[0]?.tokens).toBe(123);
      await f.from.finish(packet.alias,accepted,f.signal);
    }finally{f.close();}
  });

  it("destination crash after credential staging is inert and resumes its metadata transaction",async()=>{
    const f=fixture();try{
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      f.target.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT,'injected crash'); END;");
      await expect(f.to.receive(packet,f.signal)).rejects.toThrow("injected crash");
      expect(f.target.account(packet.alias)).toBeUndefined();
      expect(f.source.account(packet.alias)?.enabled).toBe(false);
      expect(oauthCredential(JSON.parse(readFileSync(f.targetAuth,"utf8"))[packet.alias])).toBeUndefined();
      await expect(transactSharedCredential(f.targetAuth,packet.alias,credential(),async()=>{})).rejects.toThrow("exclusive transfer");
      await expect(transactSharedCredential(f.targetAuth,packet.alias,undefined,async()=>{})).rejects.toThrow("exclusive transfer");
      const auth=new SharedOAuthAuth({path:f.targetAuth,providerId:"openai-codex",refresh:async value=>value,toAuth:async value=>({apiKey:value.access})});
      expect(auth.has(packet.alias)).toBe(false);
      await expect(auth.credential(packet.alias,f.signal)).rejects.toThrow("no shared");
      await expect(auth.set(packet.alias,credential() as any,f.signal)).rejects.toThrow("exclusive transfer");
      await expect(auth.remove(packet.alias,f.signal)).rejects.toThrow("exclusive transfer");
      expect(()=>dropLocalCredential(f.targetAuth,packet.alias)).toThrow("exclusive transfer");
      f.target.db.exec("DROP TRIGGER fail_import");
      const accepted=await f.to.receive(packet,f.signal);
      expect(f.target.account(packet.alias)?.enabled).toBe(true);
      await f.from.finish(packet.alias,accepted,f.signal);
    }finally{f.close();}
  });

  it("resumes after metadata import and credential promotion without resetting usage or rotated credentials",async()=>{
    const f=fixture();try{
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      f.target.db.exec("CREATE TRIGGER fail_enable BEFORE UPDATE OF enabled ON account WHEN NEW.enabled=1 BEGIN SELECT RAISE(ABORT,'injected enable crash'); END;");
      await expect(f.to.receive(packet,f.signal)).rejects.toThrow("injected enable crash");
      expect(f.target.account(packet.alias)?.enabled).toBe(false);
      await transactSharedCredential(f.targetAuth,packet.alias,credential("provider-account","rotated"),async()=>{});
      f.target.db.exec("DROP TRIGGER fail_enable");
      const accepted=await f.to.receive(packet,f.signal);
      expect(f.target.account(packet.alias)?.enabled).toBe(true);
      expect(f.target.usageSince(0)[0]?.tokens).toBe(123);
      expect(JSON.parse(readFileSync(f.targetAuth,"utf8"))[packet.alias].refresh).toBe("refresh-rotated");
      await f.from.finish(packet.alias,accepted,f.signal);
    }finally{f.close();}
  });

  it("ignores unrelated provider credentials and detects a changed staged identity",async()=>{
    const f=fixture();try{
      writeFileSync(f.targetAuth,JSON.stringify({anthropic:{type:"oauth",access:"not-a-codex-jwt",refresh:"anthropic-refresh",expires:Date.now()+3600000}}));
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      f.target.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT,'injected crash'); END;");
      await expect(f.to.receive(packet,f.signal)).rejects.toThrow("injected crash");
      const staged=JSON.parse(readFileSync(f.targetAuth,"utf8"));staged[packet.alias].credential=credential("other-identity");writeFileSync(f.targetAuth,JSON.stringify(staged));
      f.target.db.exec("DROP TRIGGER fail_import");
      await expect(f.to.receive(packet,f.signal)).rejects.toThrow("staging identity changed");
      expect(f.target.account(packet.alias)).toBeUndefined();
    }finally{f.close();}
  });

  it.each([true,false])("establishes durable draining custody before reporting blockers, initially enabled=%s",async enabled=>{
    const f=fixture();try{
      f.source.setAccountEnabled("openai-codex-12",enabled);
      f.source.createLease("active","openai-codex-12","interactive");
      const drain=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal);
      expect(drain).toMatchObject({type:"account-transfer-draining",phase:"preparing",blockers:["lease:active"]});
      expect(f.probe.reads).toBe(0);
      expect(f.source.account("openai-codex-12")?.enabled).toBe(false);
      expect(()=>f.source.setAccountEnabled("openai-codex-12",true)).toThrow("source cannot enable");
      expect(oauthCredential(JSON.parse(readFileSync(f.sourceAuth,"utf8"))["openai-codex-12"])).toBeDefined();
      expect(f.target.account("openai-codex-12")).toBeUndefined();
      expect(await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal)).toEqual(drain);
      f.source.endLease("active");
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      expect(packet.id).toBe(drain.id);
      expect(f.probe.reads).toBe(1);
      expect(packet.credential).toBeDefined();
      await f.from.finish(packet.alias,await f.to.receive(packet,f.signal),f.signal);
    }finally{f.close();}
  });

  it("refreshes depleted post-drain quota without enabling or handing off the account",async()=>{
    const f=fixture();try{
      f.probe.spent=100;
      const drain=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal);
      expect(drain).toMatchObject({type:"account-transfer-draining",blockers:["quota:codex-5h=100%","quota:codex-7d=100%"]});
      expect(f.probe.reads).toBe(1);
      expect(f.source.account("openai-codex-12")?.enabled).toBe(false);
      expect(oauthCredential(JSON.parse(readFileSync(f.sourceAuth,"utf8"))["openai-codex-12"])).toBeDefined();
      expect(f.target.account("openai-codex-12")).toBeUndefined();
    }finally{f.close();}
  });

  it("retains drain custody after provider read failure and resumes with a new read",async()=>{
    const f=fixture();try{
      f.probe.fail=true;
      await expect(f.from.prepare("openai-codex-12",f.to.endpoint,f.signal)).rejects.toThrow("provider unavailable");
      expect(f.source.account("openai-codex-12")?.enabled).toBe(false);
      const before=JSON.parse(f.source.control("account-transfer:openai-codex-12")!);
      f.probe.fail=false;
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      expect(packet.id).toBe(before.id);expect(f.probe.reads).toBe(2);
    }finally{f.close();}
  });

  it("refreshes a disabled source with stale meters and refuses identity collisions and source capacity loss",async()=>{
    const f=fixture();try{
      f.source.setAccountEnabled("keep-a",false);
      await expect(f.from.prepare("openai-codex-12",f.to.endpoint,f.signal)).rejects.toThrow("fewer than two");
      f.source.setAccountEnabled("keep-a",true);
      f.source.setAccountEnabled("openai-codex-12",false);
      f.source.db.prepare("UPDATE meter SET observed_at=observed_at-3600000 WHERE account_id=?").run("openai-codex-12");
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      expect(f.probe.reads).toBe(1);
      expect(f.source.account(packet.alias)?.enabled).toBe(false);
      writeFileSync(f.targetAuth,JSON.stringify({other:credential()}));
      await expect(f.to.receive(packet,f.signal)).rejects.toThrow("another alias");
      await expect(f.from.prepare(packet.alias,{host:"other",ledger:"/other"},f.signal)).rejects.toThrow("another destination");
    }finally{f.close();}
  });
});
