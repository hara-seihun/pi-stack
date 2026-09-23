import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { Store } from "../src/store.js";
import { CodexMeterSampler } from "../src/meters-codex.js";
import { AccountTransfer, prepareWithDrainWait, type TransferPacket } from "../src/auth/account-transfer.js";
import { SharedOAuthAuth, dropLocalCredential, oauthCredential, transactSharedCredential } from "../src/auth/shared-oauth.js";

const credential = (account = "provider-account", suffix = "original"): OAuthCredential => ({type:"oauth",access:`head.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:account}})).toString("base64url")}.${suffix}`,refresh:`refresh-${suffix}`,accountId:account,expires:Date.now()+3600000});
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
  return {dir,source,target,from,to,probe,sourceAuth,targetAuth,signal:AbortSignal.timeout(5000),close(){source.close();target.close();rmSync(dir,{recursive:true,force:true});}};
}

function departing(store: Store, authPath: string, endpoint: AccountTransfer["endpoint"]) {
  for (const id of ["keep-a", "keep-b"]) {
    store.upsertAccount({id, provider:"openai-codex"});
    store.recordMeter(id,"codex-7d",20,Date.now()+86400000);
  }
  return new AccountTransfer(store,authPath,endpoint,async alias=>{
    for (const meter of store.latestMeters(alias))
      store.recordMeter(alias,meter.meter_id,83,meter.reset_at,Math.max(Date.now(),meter.observed_at+1));
  });
}

function addUsage(store: Store, tokens: number) {
  store.recordUsage({accountId:"openai-codex-12",hour:1,source:"pi",runId:"historical",model:"gpt-6-astra",component:"output",tokens});
}

describe("exclusive account transfer",()=>{
  it("returns A -> B -> A with cumulative history and keeps past receipts inert",async()=>{
    const f=fixture();try{
      const first=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      const firstReceipt=await f.to.receive(first,f.signal);
      await f.from.finish(first.alias,firstReceipt,f.signal);
      // Receipts written before per-transfer sent history must also survive a return.
      f.source.db.prepare("DELETE FROM control WHERE key=?").run(`account-transfer-sent:${first.id}`);
      addUsage(f.target,77);
      await transactSharedCredential(f.targetAuth,first.alias,credential("provider-account","at-b"),async()=>{});
      const back=departing(f.target,f.targetAuth,f.to.endpoint);
      const second=await back.prepare(first.alias,await f.from.inspect(first.alias,f.signal),f.signal) as TransferPacket;
      expect(second.id).not.toBe(first.id);
      expect(second.source).toEqual(f.to.endpoint);
      expect(f.target.account(first.alias)?.enabled).toBe(false);
      expect(await back.receive(first,f.signal)).toEqual(firstReceipt);
      expect(oauthCredential(JSON.parse(readFileSync(f.targetAuth,"utf8"))[first.alias])).toBeUndefined();
      const returned=await f.from.receive(second,f.signal);
      expect(f.source.account(first.alias)?.enabled).toBe(true);
      expect(f.source.usageSince(0)[0]?.tokens).toBe(200);
      expect(f.source.db.prepare("SELECT COUNT(*) n FROM lease").get()).toEqual({n:1});
      expect(f.source.meters(first.alias)).toEqual(f.target.meters(first.alias));
      await back.finish(first.alias,returned,f.signal);
      await transactSharedCredential(f.sourceAuth,first.alias,credential("provider-account","returned"),async()=>{});
      addUsage(f.source,19);
      expect(await f.from.finish(first.alias,firstReceipt,f.signal)).toEqual(firstReceipt);
      expect(await back.receive(first,f.signal)).toEqual(firstReceipt);
      expect(await f.from.receive(second,f.signal)).toEqual(returned);
      expect(JSON.parse(readFileSync(f.sourceAuth,"utf8"))[first.alias].refresh).toBe("refresh-returned");
      expect(oauthCredential(JSON.parse(readFileSync(f.targetAuth,"utf8"))[first.alias])).toBeUndefined();
      expect(f.source.usageSince(0)[0]?.tokens).toBe(219);
      expect(f.target.usageSince(0)[0]?.tokens).toBe(200);
      expect(()=>f.target.setAccountEnabled(first.alias,true)).toThrow("source cannot enable");
      const third=await f.from.prepare(first.alias,await back.inspect(first.alias,f.signal),f.signal) as TransferPacket;
      expect(third.id).not.toBe(first.id);
      const thirdReceipt=await back.receive(third,f.signal);
      await f.from.finish(first.alias,thirdReceipt,f.signal);
      expect(await back.finish(first.alias,returned,f.signal)).toEqual(returned);
      expect(f.target.account(first.alias)?.enabled).toBe(true);
      expect(f.target.usageSince(0)[0]?.tokens).toBe(219);
      expect(JSON.parse(readFileSync(f.targetAuth,"utf8"))[first.alias].refresh).toBe("refresh-returned");
    }finally{f.close();}
  });

  it("moves A -> B -> C and acknowledges earlier deliveries after B no longer owns credentials",async()=>{
    const f=fixture(),third=Store.open(join(f.dir,"third.db"));try{
      const thirdAuth=join(f.dir,"third-auth.json");writeFileSync(thirdAuth,"{}");
      const c=new AccountTransfer(third,thirdAuth,{host:"third",ledger:"/third.db"});
      const first=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      const firstReceipt=await f.to.receive(first,f.signal);
      addUsage(f.target,77);
      const b=departing(f.target,f.targetAuth,f.to.endpoint);
      const second=await b.prepare(first.alias,await c.inspect(first.alias,f.signal),f.signal) as TransferPacket;
      expect(second.id).not.toBe(first.id);
      const secondReceipt=await c.receive(second,f.signal);
      await b.finish(second.alias,secondReceipt,f.signal);
      expect(await b.receive(first,f.signal)).toEqual(firstReceipt);
      await f.from.finish(first.alias,firstReceipt,f.signal);
      expect(oauthCredential(JSON.parse(readFileSync(f.sourceAuth,"utf8"))[first.alias])).toBeUndefined();
      expect(oauthCredential(JSON.parse(readFileSync(f.targetAuth,"utf8"))[first.alias])).toBeUndefined();
      expect(oauthCredential(JSON.parse(readFileSync(thirdAuth,"utf8"))[first.alias])).toBeDefined();
      expect(third.usageSince(0)[0]?.tokens).toBe(200);
      expect(f.source.usageSince(0)[0]?.tokens).toBe(123);
      expect(f.target.usageSince(0)[0]?.tokens).toBe(200);
      await expect(b.receive({...first,source:{host:"imposter",ledger:"/source.db"}},f.signal)).rejects.toThrow("receipt conflict");
    }finally{third.close();f.close();}
  });

  it.each(["metadata", "promotion"])("resumes a returning transfer after a %s crash",async phase=>{
    const f=fixture();try{
      const first=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      await f.from.finish(first.alias,await f.to.receive(first,f.signal),f.signal);
      addUsage(f.target,77);
      const b=departing(f.target,f.targetAuth,f.to.endpoint);
      const second=await b.prepare(first.alias,f.from.endpoint,f.signal) as TransferPacket;
      f.source.db.exec(phase==="metadata"
        ? "CREATE TRIGGER fail_return BEFORE UPDATE ON account BEGIN SELECT RAISE(ABORT,'return crash'); END;"
        : "CREATE TRIGGER fail_return BEFORE UPDATE OF enabled ON account WHEN NEW.enabled=1 BEGIN SELECT RAISE(ABORT,'return crash'); END;");
      await expect(f.from.receive(second,f.signal)).rejects.toThrow("return crash");
      expect(f.source.account(first.alias)?.enabled).toBe(false);
      expect(f.target.account(first.alias)?.enabled).toBe(false);
      expect(f.source.usageSince(0)[0]?.tokens).toBe(phase==="metadata"?123:200);
      if(phase==="metadata")expect(oauthCredential(JSON.parse(readFileSync(f.sourceAuth,"utf8"))[first.alias])).toBeUndefined();
      else await transactSharedCredential(f.sourceAuth,first.alias,credential("provider-account","rotated-return"),async()=>{});
      f.source.db.exec("DROP TRIGGER fail_return");
      const restarted=new AccountTransfer(f.source,f.sourceAuth,f.from.endpoint);
      const accepted=await restarted.receive(second,f.signal);
      await b.finish(second.alias,accepted,f.signal);
      expect(f.source.usageSince(0)[0]?.tokens).toBe(200);
      expect(f.source.account(first.alias)?.enabled).toBe(true);
      if(phase==="promotion")expect(JSON.parse(readFileSync(f.sourceAuth,"utf8"))[first.alias].refresh).toBe("refresh-rotated-return");
    }finally{f.close();}
  });

  it("rejects live aliases, unproved disabled aliases, pending departures and a different returning identity",async()=>{
    const f=fixture();try{
      await expect(f.from.inspect("openai-codex-12",f.signal)).rejects.toThrow("already has");
      f.target.upsertAccount({id:"openai-codex-12",provider:"openai-codex",enabled:false});
      await expect(f.to.inspect("openai-codex-12",f.signal)).rejects.toThrow("already has");
      const first=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      await expect(f.from.inspect(first.alias,f.signal)).rejects.toThrow("already has");
      await expect(f.to.receive(first,f.signal)).rejects.toThrow("alias collision");
      f.target.removeAccount(first.alias);
      await f.from.finish(first.alias,await f.to.receive(first,f.signal),f.signal);
      const b=departing(f.target,f.targetAuth,f.to.endpoint);
      const second=await b.prepare(first.alias,f.from.endpoint,f.signal) as TransferPacket;
      await expect(f.from.receive({...second,credential:credential("different"),identity:"not-the-provider-identity"},f.signal)).rejects.toThrow("Invalid account transfer");
      const other=fixture();try{
        await transactSharedCredential(other.sourceAuth,first.alias,credential("different"),async()=>{});
        const different=await other.from.prepare(first.alias,f.to.endpoint,f.signal) as TransferPacket;
        await expect(f.from.receive({...different,source:f.to.endpoint,destination:f.from.endpoint},f.signal)).rejects.toThrow("alias collision");
      }finally{other.close();}
      expect(f.source.account(first.alias)?.enabled).toBe(false);
      expect(oauthCredential(JSON.parse(readFileSync(f.sourceAuth,"utf8"))[first.alias])).toBeUndefined();
    }finally{f.close();}
  });
  it("explicit owning sampler reads a disabled account without changing admission",async()=>{
    const f=fixture();try{
      f.source.setAccountEnabled("openai-codex-12",false);
      const auth=new SharedOAuthAuth({path:f.sourceAuth,providerId:"openai-codex",refresh:async value=>value,toAuth:async value=>({apiKey:value.access})});
      const requests:string[]=[];
      const sampler=new CodexMeterSampler(f.source,{auth,meters:[{id:"codex-5h",windowHours:5},{id:"codex-7d",windowHours:168}],fetch:async url=>{
        requests.push(String(url));
        if(String(url).includes("rate-limit-reset-credits"))return Response.json({credits:[],available_count:0});
        return Response.json({rate_limit:{primary_window:{used_percent:21,limit_window_seconds:18000,reset_at:(Date.now()+3600000)/1000},secondary_window:{used_percent:91,limit_window_seconds:604800,reset_at:(Date.now()+86400000)/1000}}});
      }});
      expect((await sampler.sample()).filter(row=>row.accountId==="openai-codex-12")).toEqual([]);
      expect(requests).toHaveLength(0);
      const result=await sampler.sampleAccount("openai-codex-12");
      expect(result.filter(row=>row.meterId).map(row=>[row.meterId,row.outcome,row.usedPercent])).toEqual([["codex-5h","recorded",21],["codex-7d","recorded",91]]);
      expect(f.source.resetCredits("openai-codex-12")).toMatchObject({available:0});
      expect(requests).toHaveLength(2);expect(requests[0]).toContain("/codex/usage");expect(requests[1]).toContain("rate-limit-reset-credits");
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
      await expect(auth.set(packet.alias,credential(),f.signal)).rejects.toThrow("exclusive transfer");
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
      const preparing:string[]=[];
      const packet=await prepareWithDrainWait(f.from,"openai-codex-12",f.to.endpoint,f.signal,{
        waitForDrainMs:1_000,
        retryIntervalMs:1,
        onPreparing:state=>{preparing.push(state.id);f.source.endLease("active");},
      }) as TransferPacket;
      expect(preparing).toEqual([drain.id]);
      expect(packet.id).toBe(drain.id);
      expect(f.probe.reads).toBe(1);
      expect(packet.credential).toBeDefined();
      await f.from.finish(packet.alias,await f.to.receive(packet,f.signal),f.signal);
    }finally{f.close();}
  });

  it("transfers accounts whose provider exposes only a weekly quota window",async()=>{
    const f=fixture();try{
      f.source.db.prepare("DELETE FROM meter WHERE meter_id=?").run("codex-5h");
      const packet=await f.from.prepare("openai-codex-12",f.to.endpoint,f.signal) as TransferPacket;
      expect(packet.facts.meters.every(meter=>meter.meter_id==="codex-7d")).toBe(true);
      expect(f.probe.reads).toBe(1);
      await f.to.receive(packet,f.signal);
      expect(f.target.account(packet.alias)?.enabled).toBe(true);
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
