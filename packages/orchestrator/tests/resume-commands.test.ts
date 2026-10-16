import { afterEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/commands.js";

vi.mock("../src/daemon.js",()=>({Daemon:vi.fn()}));
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});

it.each([
  {argv:["pause","--ordinary"],path:"/v1/control",body:{key:"ordinary-launches",value:"paused"}},
  {argv:["resume","--ordinary"],path:"/v1/control",body:{key:"ordinary-launches",value:"enabled"}},
  {argv:["pause"],path:"/v1/control",body:{key:"launches",value:"paused"}},
  {argv:["resume"],path:"/v1/control",body:{key:"launches",value:"enabled"}},
  {argv:["close","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"close"}},
  {argv:["stop","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"close"}},
  {argv:["reopen","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"reopen"}},
  {argv:["restore","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"reopen"}},
  {argv:["cancel","THREAD-123"],path:"/v1/threads/control",body:{threadId:"THREAD-123",action:"cancel"}},
  {argv:["dependencies","A","B","C"],path:"/v1/threads/control",body:{threadId:"A",action:"dependencies",threadIds:["B","C"]}},
  {argv:["dependencies","A","--clear"],path:"/v1/threads/control",body:{threadId:"A",action:"dependencies",threadIds:[]}},
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

it.each([
  ["resume","THREAD-123"], ["resume",""], ["stop","THREAD-123","--descendants"],
  ["restore","THREAD-123","--resume"], ["dependencies","A"], ["dependencies","A","B","--clear"],
])("rejects ambiguous or recursive lifecycle commands %j",async(...argv)=>{
  const fetch=vi.spyOn(globalThis,"fetch");
  await expect(dispatch(argv)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("reports unconfirmed cancellation rather than claiming closure",async()=>{
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  const failure={ok:false,error:{code:"cancellation_failed",message:"Native cancellation unconfirmed"}};
  vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json(failure));
  await dispatch(["close","B"]);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject(failure);
});
