import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceBroker } from "./broker";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

function broker(responses:Response[]){
  const root=mkdtempSync(join(tmpdir(),"voice-broker-"));roots.push(root);
  const authPath=join(root,"auth.json");
  writeFileSync(authPath,JSON.stringify({"openai-codex-1":{type:"oauth",access:"access",refresh:"refresh",expires:Date.now()+3_600_000,accountId:"account"}}));
  const acquired:string[]=[];const released:string[]=[];
  return {
    acquired,released,
    value:new VoiceBroker({authPath,accounts:()=>[{id:"openai-codex-1",provider:"openai-codex"}],acquireLease:(account)=>{acquired.push(account);return`voice:${account}`;},releaseLease:(lease)=>released.push(lease),fetch:async()=>responses.shift()!}),
  };
}

const offer="v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";

describe("voice account leases",()=>{
  test("returns the live lease with a successful WebRTC negotiation",async()=>{
    const run=broker([Response.json({rate_limit:{primary_window:{used_percent:10}}}),new Response("answer",{status:201})]);
    expect(await run.value.negotiate(offer,"instructions")).toMatchObject({ok:true,account:"openai-codex-1",leaseId:"voice:openai-codex-1"});
    expect(run.acquired).toEqual(["openai-codex-1"]);expect(run.released).toEqual([]);
  });

  test("releases the lease after quota refusal or negotiation failure",async()=>{
    const exhausted=broker([Response.json({rate_limit:{primary_window:{used_percent:100}}})]);
    expect(await exhausted.value.negotiate(offer,"instructions")).toMatchObject({ok:false,status:429});
    expect(exhausted.released).toEqual(["voice:openai-codex-1"]);

    const failed=broker([Response.json({rate_limit:{primary_window:{used_percent:10}}}),new Response("upstream failed",{status:500})]);
    expect(await failed.value.negotiate(offer,"instructions")).toMatchObject({ok:false,status:503});
    expect(failed.released).toEqual(["voice:openai-codex-1"]);
  });
});
