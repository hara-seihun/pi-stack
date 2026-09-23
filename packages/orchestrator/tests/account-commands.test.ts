import { afterEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/commands.js";

afterEach(()=>vi.restoreAllMocks());
it("routes account reservations without importing an account or changing force admission",async()=>{
  const calls:{url:string;method:string;body:unknown}[]=[];
  vi.spyOn(console,"log").mockImplementation(()=>{});
  vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
    calls.push({url:String(input),method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});
    return Response.json({ok:true});
  });
  await dispatch(["account","reserve","openai-codex-12","--metadata",'{"purpose":"regulatory-atlas-tagging"}',"--reason","Atlas highest priority"]);
  await dispatch(["account","reservation","openai-codex-12"]);
  await dispatch(["account","unreserve","openai-codex-12"]);
  expect(calls.map(call=>[new URL(call.url).pathname,call.method,call.body])).toEqual([
    ["/v1/accounts/openai-codex-12/reservation","PUT",{metadata:{purpose:"regulatory-atlas-tagging"},reason:"Atlas highest priority"}],
    ["/v1/accounts/openai-codex-12/reservation","GET",undefined],
    ["/v1/accounts/openai-codex-12/reservation","DELETE",undefined],
  ]);
});
it("rejects malformed reservation metadata before contacting the daemon",async()=>{
  const fetch=vi.spyOn(globalThis,"fetch");
  for(const metadata of ["invalid","null","[]","{}"]){
    await expect(dispatch(["account","reserve","account","--metadata",metadata,"--reason","reserved"])).rejects.toThrow("--metadata");
  }
  expect(fetch).not.toHaveBeenCalled();
});
