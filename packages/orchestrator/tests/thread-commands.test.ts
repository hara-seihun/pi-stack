import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/commands.js";

vi.mock("../src/daemon.js",()=>({Daemon:vi.fn()}));
beforeEach(()=>{for(const key of ["PI_THREAD_ID","PI_THREAD_CAN_SPAWN","PI_THREAD_API_URL"])vi.stubEnv(key,undefined);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;});

function transport(responses:unknown[]=[]){
  const calls:{path:string;method:string;body:any}[]=[];
  vi.spyOn(console,"log").mockImplementation(()=>{});
  vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
    calls.push({path:new URL(String(input)).pathname,method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});
    return Response.json(responses.length?responses.shift():{ok:true,value:{id:`thread-${calls.length}`}});
  });
  return calls;
}

it("preserves an agent caller as parent and uses its authorized directory",async()=>{
  vi.stubEnv("PI_THREAD_ID","caller");
  vi.stubEnv("PI_THREAD_API_URL","http://127.0.0.1:18790/v1/threads");
  const calls=transport();
  await dispatch(["run","--prompt","bounded work"]);
  expect(calls[0]!.body).toMatchObject({parentId:"caller",ephemeral:true});
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("http://127.0.0.1:18790/v1/threads/spawn");
  await expect(dispatch(["run","--prompt","work","--parent","another"])).rejects.toThrow("own thread");
  await expect(dispatch(["wave","review"])).rejects.toThrow("unparented waves");
  expect(calls).toHaveLength(1);
});

it.each([
  {senderId:undefined,selected:undefined,expected:"queue"},
  {senderId:"caller",selected:undefined,expected:"steer"},
  ...["queue","steer","hardSteer"].map(selected=>({senderId:undefined,selected,expected:selected})),
  ...["steer","hardSteer"].map(selected=>({senderId:"caller",selected,expected:selected})),
])("sends with sender $senderId and delivery $selected as $expected",async({senderId,selected,expected})=>{
  vi.stubEnv("PI_THREAD_ID",senderId);
  vi.stubEnv("PI_THREAD_API_URL","http://127.0.0.1:18790/v1/threads");
  const calls=transport();
  await dispatch(["send","recipient","--prompt","work",...(selected?["--delivery",selected]:[])]);
  expect(calls[0]!.body).toEqual({requestId:expect.any(String),threadId:"recipient",text:"work",delivery:expected,...(senderId?{senderId}:{})});
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("http://127.0.0.1:18790/v1/threads/send");
});

it("rejects agent queue delivery before transport",async()=>{
  vi.stubEnv("PI_THREAD_ID","caller");
  const calls=transport();
  await expect(dispatch(["send","recipient","--prompt","work","--delivery","queue"])).rejects.toThrow("steer or hardSteer");
  expect(calls).toHaveLength(0);
});

it("workers cannot bypass the missing spawn tool with CLI run or wave",async()=>{
  vi.stubEnv("PI_THREAD_CAN_SPAWN","0");
  const calls=transport();
  await expect(dispatch(["run","--prompt","work"])).rejects.toThrow("cannot spawn");
  await expect(dispatch(["wave","review"])).rejects.toThrow("unparented waves");
  expect(calls).toHaveLength(0);
});

it("spawns fresh forced threads without resolving server settings",async()=>{
  const calls=transport();
  await dispatch(["run","--prompt","do work","--cwd","/work","--count","2"]);
  expect(calls).toHaveLength(2);
  for(const call of calls)expect(call).toEqual({path:"/v1/threads/spawn",method:"POST",body:{requestId:expect.any(String),message:"do work",cwd:"/work",admission:"force",ephemeral:false}});
  expect(calls[0]!.body.requestId).not.toBe(calls[1]!.body.requestId);
});

it.each([
  {caller:undefined,args:["--parent","parent","--ephemeral"],ephemeral:true},
  {caller:"parent",args:["--ephemeral=true"],ephemeral:true},
  {caller:"parent",args:["--ephemeral=false"],ephemeral:false},
])("sends explicit ephemeral=$ephemeral with caller $caller",async({caller,args,ephemeral})=>{
  vi.stubEnv("PI_THREAD_ID",caller);
  const calls=transport();
  await dispatch(["run","--prompt","work",...args]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toMatchObject({parentId:"parent",ephemeral});
});

it("sends explicit model, thinking, speed and admission overrides",async()=>{
  const calls=transport();
  await dispatch(["run","--prompt","work","--model","luna","--thinking","high","--speed","priority","--background","--parent","parent"]);
  expect(calls[0]!.body).toMatchObject({settings:{model:"luna",thinkingLevel:"high",speed:"priority"},admission:"background",parentId:"parent"});
});

it("stops a failed batch and includes the threads already accepted",async()=>{
  const calls=transport([{ok:true,value:{id:"accepted"}},{ok:false,error:{code:"unavailable",message:"Paused"}}]);
  await dispatch(["run","--prompt","work","--count","3"]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
  expect(calls[1]!.body.requestId).toEqual(expect.any(String));
  expect(calls[1]!.body.requestId).not.toBe(calls[0]!.body.requestId);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({ok:false,error:{code:"unavailable",message:"Paused",retryable:false,requestId:calls[1]!.body.requestId},threads:[{id:"accepted"}]});
});

it("reports a terminal send rejection with the submitted request identity",async()=>{
  const calls=transport([{ok:false,error:{code:"conflict",message:"Identity already used"}}]);
  await dispatch(["send","recipient","--prompt","work"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.requestId).toEqual(expect.any(String));
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({ok:false,error:{code:"conflict",message:"Identity already used",retryable:false,requestId:calls[0]!.body.requestId}});
});

it("creates and controls recurring jobs through the person's daemon",async()=>{
  const calls=transport();
  await dispatch(["schedule","create","--id","digest","--prompt","Review work","--cwd","/work","--every","6h","--start","2026-09-22T09:00:00Z","--model","sol","--thinking","high","--background"]);
  await dispatch(["schedule","pause","digest"]);
  await dispatch(["schedule","show","digest"]);
  await dispatch(["schedule","remove","digest","--yes"]);
  expect(calls).toEqual([
    {path:"/v1/schedules",method:"POST",body:{id:"digest",prompt:"Review work",cwd:"/work",intervalMs:21_600_000,startAt:Date.parse("2026-09-22T09:00:00Z"),settings:{model:"sol",thinkingLevel:"high"},admission:"background"}},
    {path:"/v1/schedules/digest/pause",method:"POST",body:undefined},
    {path:"/v1/schedules/digest",method:"GET",body:undefined},
    {path:"/v1/schedules/digest",method:"DELETE",body:undefined},
  ]);
});

it("requires explicit confirmation before deleting a recurring job",async()=>{
  const calls=transport();
  await expect(dispatch(["schedule","remove","digest"])).rejects.toThrow("requires --yes");
  expect(calls).toHaveLength(0);
});

it("lets the daemon resolve lane prompts, doctrine and admission before spawning threads",async()=>{
  const calls=transport([{threads:[{id:"review-thread"}]}]);
  await dispatch(["wave","review"]);
  expect(calls).toEqual([{path:"/v1/wave",method:"POST",body:{lane:"review",count:1}}]);
});

it.each([
  {argv:["read","thread/id","--cursor","page","--limit","5"],operation:"read",body:{threadId:"thread/id",cursor:"page",limit:5}},
  {argv:["list","--parent","parent","--state","idle","--limit","4"],operation:"list",body:{parentId:"parent",state:"idle",limit:4}},
  {argv:["send","thread/id","--prompt","new work","--delivery","hardSteer"],operation:"send",body:{requestId:expect.any(String),threadId:"thread/id",text:"new work",delivery:"hardSteer"}},
])("uses native thread $operation",async({argv,operation,body})=>{
  const calls=transport();
  await dispatch(argv);
  expect(calls).toEqual([{path:`/v1/threads/${operation}`,method:"POST",body}]);
});

it.each([
  ["run","--prompt","work","--count","0"],
  ["run","--prompt","work","--count","1.5"],
  ["run","--prompt","work","--profile","standard"],
  ["run","--prompt","work","--thinking","invalid"],
  ["run","--prompt","work","--ephemeral=invalid"],
  ["send","thread","--prompt","work","--delivery","cancel"],
  ["worker","run"],["recover","run"],["abort","run"],["kill","run"],
])("rejects unsupported input %j before contacting the daemon",async(...argv)=>{
  const calls=transport();
  await expect(dispatch(argv)).rejects.toThrow();
  expect(calls).toEqual([]);
});
