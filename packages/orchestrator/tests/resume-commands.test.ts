import { afterEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/commands.js";

afterEach(()=>vi.restoreAllMocks());

it.each([
  {argv:["resume"],path:"/v1/control",body:{key:"launches",value:"enabled"}},
  {argv:["resume","RUN-123"],path:"/v1/runs/RUN-123/resume",body:undefined},
  {argv:["resume","run/with space"],path:"/v1/runs/run%2Fwith%20space/resume",body:undefined},
])("dispatches $argv to $path",async({argv,path,body})=>{
  const calls:{path:string;method:string;body:unknown}[]=[];
  vi.spyOn(console,"log").mockImplementation(()=>{});
  vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
    calls.push({path:new URL(String(input)).pathname,method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});
    return Response.json({ok:true});
  });

  await dispatch(argv);

  expect(calls).toEqual([{path,method:"POST",body}]);
});

it("rejects an empty run id without clearing the global launch halt",async()=>{
  const fetch=vi.spyOn(globalThis,"fetch");
  await expect(dispatch(["resume",""])).rejects.toThrow("resume requires a run id");
  expect(fetch).not.toHaveBeenCalled();
});
