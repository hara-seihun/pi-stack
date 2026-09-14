import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openCoreSession, type CoreOutput } from "../src/cores/index.js";

it("rejects a Codex native file without modifying it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "core-import-"));
  const file = join(stateDir, "native.jsonl");
  const content = JSON.stringify({ type: "session_meta", payload: { id: "codex-native" } }) + "\n";
  writeFileSync(file, content);
  try {
    await expect(openCoreSession({ sessionId: "root", stateDir, cwd: stateDir, args: ["--session", file], env: {} }, () => {}, () => {}))
      .rejects.toThrow("Not a native Pi session");
    expect(readFileSync(file, "utf8")).toBe(content);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

it("does not adopt a Codex-owned state directory as an empty Pi session", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "core-owner-"));
  writeFileSync(join(stateDir, "codex-session.json"), JSON.stringify({ threadId: "native-codex" }));
  try {
    await expect(openCoreSession({ sessionId: "root", stateDir, cwd: stateDir, args: [], env: {} }, () => {}, () => {}))
      .rejects.toThrow("portable transfer into a new Pi state directory");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

it("retains a Codex portable transfer as provenance when reopening Pi", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "core-transfer-"));
  const transfer = { version: 1, sourceCore: "codex", messages: [{ role: "user", content: "existing conversation" }], agents: [] };
  writeFileSync(join(stateDir, "transfer.json"), JSON.stringify(transfer));
  const events: CoreOutput[] = [];
  try {
    for (let generation = 0; generation < 2; generation++) {
      const session = await openCoreSession({ sessionId: "root", stateDir, cwd: stateDir, args: [], env: {} }, event => events.push(event), () => {}, async options => {
        expect(options.transfer).toEqual(transfer);
        return { async command() {}, async close() {} };
      });
      await session.command({ type: "get_portable_conversation" });
      expect(events.at(-1)?.data).toMatchObject({ sourceCore: "pi", messages: transfer.messages });
      await session.close();
    }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

it("owns the portable record and preserves native session state behind the adapter", async () => {
  const stateDir=mkdtempSync(join(tmpdir(),"core-host-"));
  const events:CoreOutput[]=[];
  let closed=0;
  let nativeOutput:(event:CoreOutput)=>void=()=>{};
  try {
    const session=await openCoreSession({sessionId:"root",stateDir,cwd:stateDir,args:[],env:{}},event=>events.push(event),()=>{},async(_options,output)=>{
      nativeOutput=output;
      return {async command(command){
        if(command.type==="prompt")output({type:"message_end",message:{id:"message",role:"assistant",timestamp:1,content:[{type:"text",text:"done",textSignature:"native-only"}]}});
        output({type:"response",id:command.id,command:command.type,success:true,data:{sessionFile:"native-reference"}});
      },async close(){closed++;}};
    });
    await session.command({type:"prompt",id:"input",message:"work"});
    await session.command({type:"get_state",id:"state"});
    expect(events.at(-1)?.data).toMatchObject({core:"pi",sessionFile:"native-reference",portableFile:join(stateDir,"conversation.jsonl")});
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
