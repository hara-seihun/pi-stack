import { expect, test, mock, spyOn } from "bun:test";
import type { NativeRunnerOwner } from "../src/threads/runner-ownership.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { ThreadService } from "../src/threads/service.js";
const ownership = await import("../src/threads/runner-ownership.js");
let syntheticOwner: NativeRunnerOwner;
mock.module("../src/threads/runner-ownership.js", () => ({ ...ownership, nativeStorageOwner: () => syntheticOwner }));
const { createSharedPiSessionOpener } = await import("../src/threads/runner-transport.js");
import type { PiSession } from "../src/threads/contracts.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i=0; i<200; i++) { if(check()) return; await delay(2); }
  throw Error("Synthetic transport did not reach expected state");
}

test.each(["refused", "timeout"])("failed retained open (%s) detaches only its observer before replacement", async mode => {
  const root=mkdtempSync(join(tmpdir(),"retained-observer-"));
  const reference={control:join(root,"thread-runners/group.sock"),socketPath:join(root,"thread-sockets/group.thread.sock")};
  syntheticOwner={version:1,dataDir:root,uid:process.getuid!(),control:reference.control,pid:process.pid,startTicks:"synthetic"};
  const sockets=new Set<Socket>(), servers: ReturnType<typeof createServer>[]=[];
  const requests: string[]=[]; let attaches=0, current:Socket|undefined, rejectState=true, sequence=0;
  const listen=async(path:string, receive:(value:any,socket:Socket)=>void)=>{
    mkdirSync(dirname(path),{recursive:true});
    const server=createServer(socket=>{sockets.add(socket);socket.on("error",()=>{});socket.on("close",()=>sockets.delete(socket));
      createInterface({input:socket}).on("line",line=>receive(JSON.parse(line),socket));});
    servers.push(server); await new Promise<void>(resolve=>server.listen(path,resolve));
  };
  await listen(reference.control,(value,socket)=>{requests.push(value.type);socket.end(JSON.stringify({ok:true,pid:process.pid})+'\n');});
  await listen(reference.socketPath,(value,socket)=>{
    if(value.type==="attach") { attaches++; const old=current;current=socket;if(old!==socket)old?.destroy(); socket.write('{"type":"attached"}\n'); }
    if(value.type==="command") {
      requests.push(value.value.type);
      if(rejectState && mode === "timeout") return; // No acknowledgement: exercise the actual RPC timeout catch.
      const event={type:"response",command:value.value.type,id:value.value.id,success:!rejectState,
        ...(rejectState?{error:"synthetic state refusal"}:{data:{isStreaming:false,isCompacting:false,nativeProtocolVersion:"batch-operations-v1"}})};
      socket.write(JSON.stringify({type:"output",sequence:++sequence,line:JSON.stringify(event)})+'\n');
    }
  });
  const opener=createSharedPiSessionOpener({dataDir:root}); const returned:PiSession[]=[];
  const service=new ThreadService({capacity:{mode:"unmanaged"},databasePath:join(root,"threads.sqlite"),sessionsDir:root,
    openSession:async (_options,output,exit)=>{const session=await opener.attachSession(reference,output,code=>exit(code === null ? undefined : code));if(!session)throw Error("Synthetic native missing"); returned.push(session);return session;}});
  const imported=service.importThread({id:"child",title:"Child",cwd:root,sessionFile:join(root,"child.jsonl"),
    settings:{model:"sol",thinkingLevel:"high",speed:"standard"},metadata:{runnerReference:reference}});
  if(!imported.ok)throw Error(imported.error.message);
  try {
    // Exercise the exact failed-open owner, without starting any dispatcher/model work.
    const open=()=> (service as any).openOwned("child",imported.value.settings,false,{});
    const realSetTimeout=globalThis.setTimeout;
    const clock=spyOn(globalThis,"setTimeout").mockImplementation(((fn:any,ms:any,...args:any[])=>realSetTimeout(fn,ms===30_000?5:ms,...args)) as typeof setTimeout);
    try { await expect(open()).rejects.toThrow(mode === "timeout" ? "timed out" : "synthetic state refusal"); }
    finally { clock.mockRestore(); }
    expect((service as any).runtimes.has("child")).toBe(false);
    await expect(returned[0]!.command({type:"get_state"})).rejects.toThrow("detached");
    returned[0]!.detach?.(); returned[0]!.detach?.(); // Observation disposal is idempotent.
    rejectState=false;
    await open();
    await until(()=>attaches>=2);
    await delay(100); // Four former 25ms reconnect periods: discarded observer must remain inert.
    expect(attaches).toBe(2);
    expect(service.get("child")?.metadata?.runnerReference).toEqual(reference);
    expect(requests.filter(type=>["close","drain","abort","input_batch","prompt","resume_pending"].includes(type))).toEqual([]);
    await expect(returned[0]!.command({type:"get_state"})).rejects.toThrow("detached");
    const result=await service.command("child",{type:"get_state"});expect(result.ok).toBe(true);
  } finally {
    opener.detach();for(const socket of sockets)socket.destroy();
    await service.close();await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
    rmSync(root,{recursive:true,force:true});
  }
}, 3000);
