import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openCoreSession, type CoreOutput } from "../src/cores/index.js";

it("owns the portable record and preserves native session state behind the adapter", async () => {
  const stateDir=mkdtempSync(join(tmpdir(),"core-host-"));
  const events:CoreOutput[]=[];
  let closed=0;
  let nativeOutput:(event:CoreOutput)=>void=()=>{};
  try {
    const session=await openCoreSession({sessionId:"root",stateDir,cwd:stateDir,args:[],env:{PI_STACK_CORE:"codex"}},event=>events.push(event),()=>{},async(_options,output)=>{
      nativeOutput=output;
      return {async command(command){
        if(command.type==="prompt")output({type:"message_end",message:{id:"message",role:"assistant",timestamp:1,content:[{type:"text",text:"done",textSignature:"native-only"}]}});
        output({type:"response",id:command.id,command:command.type,success:true,data:{sessionFile:"native-reference"}});
      },async close(){closed++;}};
    });
    await session.command({type:"prompt",id:"input",message:"work"});
    await session.command({type:"get_state",id:"state"});
    expect(events.at(-1)?.data).toMatchObject({core:"codex",sessionFile:"native-reference",portableFile:join(stateDir,"conversation.jsonl")});
    await session.command({type:"get_portable_conversation",id:"export"});
    expect(JSON.stringify(events.at(-1))).not.toContain("native-only");
    expect((events.at(-1)?.data as any).messages[0].content[0].text).toBe("done");
    await session.close();await session.close();
    expect(closed).toBe(1);
    const count=events.length;
    nativeOutput({type:"agent_settled"});
    expect(events).toHaveLength(count);
  } finally {rmSync(stateDir,{recursive:true,force:true});}
});
