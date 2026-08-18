import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { contextMetrics, fingerprint, UsageDatabase } from "./database.mjs";
import { createUsageLogger } from "./logger.mjs";

function harness() {
  const handlers = new Map();
  return {
    handlers,
    pi: {
      on(name,handler) {
        if (!handlers.has(name)) handlers.set(name,[]);
        handlers.get(name).push(handler);
      },
      getActiveTools: () => ["read"],
      getAllTools: () => [{ name:"read",description:"read files",parameters:{type:"object"},promptGuidelines:[],sourceInfo:{} }],
    },
    async emit(name,event,ctx) {
      let result;
      for (const handler of handlers.get(name) ?? []) result = await handler(event,ctx);
      return result;
    },
  };
}

function usage(input,output,cacheRead,cacheWrite) {
  return { input,output,cacheRead,cacheWrite,totalTokens:input+output+cacheRead+cacheWrite,cost:{input:0.1,output:0.2,cacheRead:0.01,cacheWrite:0.03,total:0.34} };
}

test("fingerprints content without retaining it", () => {
  const left = fingerprint({ secret:"never-persist-this",nested:[1,true] });
  const right = fingerprint({ secret:"never-persist-this",nested:[1,true] });
  const other = fingerprint({ secret:"different",nested:[1,true] });
  assert.equal(left.hash,right.hash);
  assert.notEqual(left.hash,other.hash);
  assert(left.bytes>0);
  const metrics = contextMetrics([{role:"user",content:"abc"},{role:"toolResult",content:[{type:"text",text:"12345"}]}]);
  assert.equal(metrics.messageCount,2);
  assert.equal(metrics.userBytes,3);
  assert.equal(metrics.toolResultBytes,5);
});

test("logger records requests, tools, cache waste, and compaction without prompt content", async () => {
  const dir = await mkdtemp(join(tmpdir(),"pi-usage-test-"));
  const path = join(dir,"usage.sqlite3");
  const store = new UsageDatabase(path);
  const h = harness();
  createUsageLogger({ store,owner:{kind:"test",id:"owner-1",label:"test owner"} })(h.pi);
  const ctx = {
    cwd:"/work",
    mode:"rpc",
    model:{provider:"openai-codex-2",id:"gpt-test",api:"openai-responses"},
    thinkingLevel:"high",
    sessionManager:{getSessionId:()=>"session-1",getSessionFile:()=>"/sessions/session-1.jsonl"},
  };
  await h.emit("session_start",{reason:"startup"},ctx);
  await h.emit("before_agent_start",{systemPrompt:"SYSTEM-SECRET",systemPromptOptions:{}},ctx);
  await h.emit("agent_start",{},ctx);
  await h.emit("turn_start",{turnIndex:0,timestamp:1000},ctx);
  await h.emit("context",{messages:[{role:"user",content:"USER-SECRET"}]},ctx);
  await h.emit("before_provider_request",{payload:{instructions:"SYSTEM-SECRET",input:[{role:"user",content:"USER-SECRET"}],tools:[],service_tier:"priority"}},ctx);
  await h.emit("after_provider_response",{status:429,headers:{"retry-after":"1",authorization:"MUST-NOT-PERSIST"}},ctx);
  await h.emit("after_provider_response",{status:200,headers:{"x-request-id":"safe-id",authorization:"MUST-NOT-PERSIST"}},ctx);
  await h.emit("message_start",{message:{role:"assistant"}},ctx);
  await h.emit("tool_execution_start",{toolCallId:"call-1",toolName:"read",args:{path:"PRIVATE-PATH"}},ctx);
  await h.emit("tool_execution_end",{toolCallId:"call-1",toolName:"read",result:{content:[{type:"text",text:"TOOL-SECRET"}]},isError:false},ctx);
  await h.emit("message_end",{message:{role:"assistant",provider:"openai-codex-2",model:"gpt-test",responseModel:"gpt-test-actual",responseId:"response-safe-id",api:"openai-responses",content:[{type:"text",text:"RESPONSE-SECRET"}],usage:usage(100,20,900,0),stopReason:"toolUse",rawStopReason:"tool_calls",timestamp:1100}},ctx);
  await h.emit("turn_end",{toolResults:[{}]},ctx);
  await h.emit("turn_start",{turnIndex:1,timestamp:1200},ctx);
  await h.emit("context",{messages:[{role:"user",content:"USER-SECRET"},{role:"toolResult",content:[{type:"text",text:"TOOL-SECRET"}]}]},ctx);
  await h.emit("before_provider_request",{payload:{input:[{role:"user",content:"USER-SECRET"}],tools:[]}},ctx);
  await h.emit("after_provider_response",{status:429,headers:{"retry-after":"2","set-cookie":"MUST-NOT-PERSIST"}},ctx);
  await h.emit("message_end",{message:{role:"assistant",provider:"openai-codex-2",model:"gpt-test",api:"openai-responses",content:[],usage:usage(300,10,500,0),stopReason:"error",errorMessage:"429 quota for PRIVATE-ACCOUNT",diagnostics:[{type:"provider_transport_failure",timestamp:1250,error:{message:"socket PRIVATE-DIAGNOSTIC"},details:{configuredTransport:"auto",fallbackTransport:"sse",phase:"before_message_stream_start",eventsEmitted:false,requestBytes:12345}}],timestamp:1300}},ctx);
  await h.emit("turn_end",{toolResults:[]},ctx);
  await h.emit("agent_end",{},ctx);
  await h.emit("agent_settled",{},ctx);
  await h.emit("session_before_compact",{reason:"threshold",willRetry:false},ctx);
  await h.emit("session_compact",{reason:"threshold",compactionEntry:{summary:"SUMMARY-SECRET",tokensBefore:1500,usage:usage(200,30,0,0)}},ctx);

  const db = new DatabaseSync(path,{readOnly:true});
  const requests = db.prepare("SELECT * FROM request ORDER BY sequence").all();
  assert.equal(requests.length,2);
  assert.equal(requests[0].cache_read_tokens,900);
  assert.equal(requests[0].service_tier,"priority");
  assert.equal(requests[0].response_model,"gpt-test-actual");
  assert.equal(requests[0].response_id,"response-safe-id");
  assert.equal(requests[0].raw_stop_reason,"tool_calls");
  assert(requests[0].stream_started_at);
  assert(requests[0].response_bytes>0);
  assert.equal(requests[0].response_text_bytes,15);
  assert.deepEqual(JSON.parse(requests[0].response_headers),{"x-request-id":"safe-id"});
  assert.equal(db.prepare("SELECT count(*) count FROM provider_attempt WHERE request_id=?").get(requests[0].request_id).count,2);
  assert.equal(requests[1].cache_miss_tokens,300);
  assert.equal(requests[1].error_category,"rate_limit");
  assert.equal(db.prepare("SELECT count(*) count FROM tool_execution").get().count,1);
  assert.equal(db.prepare("SELECT count(*) count FROM usage_event WHERE kind='compaction' AND detail_bytes>0").get().count,1);
  assert.equal(db.prepare("SELECT count(*) count FROM lifecycle_event WHERE kind='compaction_start'").get().count,1);
  assert.equal(db.prepare("SELECT count(*) count FROM request_diagnostic").get().count,1);
  assert.equal(db.prepare("SELECT retry_count FROM agent_run").get().retry_count,1);
  assert.equal(store.nextRequestSequence("session-1"),3);
  db.close();
  store.close();
  const raw = readFileSync(path);
  for (const secret of ["SYSTEM-SECRET","USER-SECRET","RESPONSE-SECRET","TOOL-SECRET","SUMMARY-SECRET","PRIVATE-PATH","PRIVATE-ACCOUNT","PRIVATE-DIAGNOSTIC","MUST-NOT-PERSIST"]) {
    assert.equal(raw.includes(Buffer.from(secret)),false,secret);
  }
  await rm(dir,{recursive:true,force:true});
});
