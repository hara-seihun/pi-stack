import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import extension,{COMPACT_THRESHOLD_TOKENS,CONTINUATION_MESSAGE} from "./index.mjs";

function harness(tokens){let listener,options,messages=[];const pi={on(name,fn){assert.equal(name,"before_provider_request");listener=fn;},sendMessage(message,delivery){messages.push({message,delivery});}};extension(pi);const ctx={getContextUsage:()=>({tokens}),compact(value){options=value;}};return{fire:()=>listener({},ctx),options:()=>options,messages};}

test("compaction begins at exactly 250,000 active-context tokens",()=>{const below=harness(COMPACT_THRESHOLD_TOKENS-1);below.fire();assert.equal(below.options(),undefined);const at=harness(COMPACT_THRESHOLD_TOKENS);at.fire();assert.ok(at.options());});

test("one compaction runs at a time and resumes the interrupted task",()=>{const run=harness(COMPACT_THRESHOLD_TOKENS);run.fire();const first=run.options();run.fire();assert.equal(run.options(),first);first.onComplete();assert.deepEqual(run.messages,[{message:{customType:"compaction-threshold",content:CONTINUATION_MESSAGE,display:false},delivery:{triggerTurn:true}}]);run.fire();assert.notEqual(run.options(),first);});

test("a failed compaction may be retried",()=>{const run=harness(COMPACT_THRESHOLD_TOKENS);run.fire();const first=run.options();first.onError();run.fire();assert.notEqual(run.options(),first);});

test("only the local threshold trigger resumes automatic compaction",()=>{const deploy=readFileSync(new URL("../../../../deploy/settings",import.meta.url),"utf8");assert.match(deploy,/"continueAfterThresholdCompact": false/);});
