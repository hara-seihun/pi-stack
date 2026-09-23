import { afterEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/commands.js";

vi.mock("../src/daemon.js",()=>({Daemon:vi.fn()}));
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});

it.each([
  {argv:["pause","--ordinary"],path:"/v1/control",body:{key:"ordinary-launches",value:"paused"}},
  {argv:["resume","--ordinary"],path:"/v1/control",body:{key:"ordinary-launches",value:"enabled"}},
  {argv:["pause"],path:"/v1/control",body:{key:"launches",value:"paused"}},
  {argv:["resume"],path:"/v1/control",body:{key:"launches",value:"enabled"}},
  {argv:["resume","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"resume"}},
  {argv:["resume","thread/with space"],path:"/v1/threads/control",body:{threadId:"thread/with space",action:"resume"}},
  {argv:["stop","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"stop",descendants:false}},
  {argv:["stop","THREAD-123","--descendants"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"stop",descendants:true}},
  {argv:["stop","--descendants","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"stop",descendants:true}},
  {argv:["stop","THREAD-123","--descendants=false"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"stop",descendants:false}},
])("dispatches $argv to $path",async({argv,path,body})=>{
  const calls:{path:string;method:string;body:unknown}[]=[];
  vi.spyOn(console,"log").mockImplementation(()=>{});
  vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
    calls.push({path:new URL(String(input)).pathname,method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});
    return Response.json({ok:true,value:{}});
  });
  await dispatch(argv);
  expect(calls).toEqual([{path,method:"POST",body}]);
});

it("rejects an empty thread id without clearing the global launch halt",async()=>{
  const fetch=vi.spyOn(globalThis,"fetch");
  await expect(dispatch(["resume",""])).rejects.toThrow("resume requires a thread id");
  expect(fetch).not.toHaveBeenCalled();
});

it("reports a held-message resume failure without clearing the global launch halt",async()=>{
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  const failure={ok:false,error:{code:"no_pending_messages",message:"No pending messages"}};
  const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json(failure));
  await dispatch(["resume","stopped"]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe("/v1/threads/control");
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({threadId:"stopped",action:"resume"});
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ok:false,error:{...failure.error,retryable:false}});
});
