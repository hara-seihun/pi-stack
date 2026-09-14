import { afterEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/commands.js";

vi.mock("../src/daemon.js",()=>({Daemon:vi.fn()}));
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
  expect(calls[0]!.body.parentId).toBe("caller");
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("http://127.0.0.1:18790/v1/threads/spawn");
  await expect(dispatch(["run","--prompt","work","--parent","another"])).rejects.toThrow("own thread");
  await expect(dispatch(["wave","review"])).rejects.toThrow("unparented waves");
  expect(calls).toHaveLength(1);
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
  for(const call of calls)expect(call).toEqual({path:"/v1/threads/spawn",method:"POST",body:{requestId:expect.any(String),message:"do work",cwd:"/work",admission:"force"}});
  expect(calls[0]!.body.requestId).not.toBe(calls[1]!.body.requestId);
});

it("sends explicit model, thinking, speed and admission overrides",async()=>{
  const calls=transport();
  await dispatch(["run","--prompt","work","--model","luna","--thinking","high","--speed","priority","--background","--parent","parent"]);
  expect(calls[0]!.body).toMatchObject({settings:{model:"luna",thinkingLevel:"high",speed:"priority"},admission:"background",parentId:"parent"});
});

it("stops a failed batch and includes the threads already accepted",async()=>{
  transport([{ok:true,value:{id:"accepted"}},{ok:false,error:{code:"unavailable",message:"Paused"}}]);
  await dispatch(["run","--prompt","work","--count","3"]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({ok:false,error:{code:"unavailable",message:"Paused"},threads:[{id:"accepted"}]});
});

it("lets the daemon resolve lane prompts, doctrine and admission before spawning threads",async()=>{
  const calls=transport([{threads:[{id:"review-thread"}]}]);
  await dispatch(["wave","review"]);
  expect(calls).toEqual([{path:"/v1/wave",method:"POST",body:{lane:"review",count:1}}]);
});

it.each([
  {argv:["read","thread/id","--cursor","page","--limit","5"],operation:"read",body:{threadId:"thread/id",cursor:"page",limit:5}},
  {argv:["list","--parent","parent","--state","stopped","--limit","4"],operation:"list",body:{parentId:"parent",state:"stopped",limit:4}},
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
  ["send","thread","--prompt","work","--delivery","cancel"],
  ["worker","run"],["recover","run"],["abort","run"],["kill","run"],
])("rejects unsupported input %j before contacting the daemon",async(...argv)=>{
  const calls=transport();
  await expect(dispatch(argv)).rejects.toThrow();
  expect(calls).toEqual([]);
});
