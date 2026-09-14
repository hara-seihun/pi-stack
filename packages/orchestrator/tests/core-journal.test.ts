import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CoreJournal, readPortableConversation } from "../src/cores/journal.js";

it("retains both native-shaped activity and a portable conversation across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "core-journal-"));
  try {
    const journal = new CoreJournal(directory, "pi", "root", directory);
    const message = {id:"native-item",role:"assistant",content:[{type:"text",text:"done"}],timestamp:12};
    journal.record({type:"message_end",message});
    journal.record({type:"message_end",message});
    journal.record({type:"core_agent",agent:{id:"child",parentId:"root",name:"Child",state:"idle"}});
    journal.record({type:"core_child_event",agentId:"child",event:{type:"message_end",message:{...message,id:"child-item"}}});
    journal.close();
    const reopened = new CoreJournal(directory, "pi", "root", directory);
    expect(reopened.conversation().messages).toEqual([message]);
    expect(reopened.conversation().agents).toHaveLength(1);
    expect(readPortableConversation(reopened.portableFile,"pi").messages).toEqual([message]);
    expect(readFileSync(reopened.eventsFile,"utf8")).toContain("core_agent");
    reopened.close();
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

it("preserves repeated messages without stable identities and exports only the current branch", () => {
  const directory = mkdtempSync(join(tmpdir(), "core-branch-"));
  try {
    const journal = new CoreJournal(directory,"pi","root",directory);
    const message = {role:"user",content:"again"};
    journal.seed([message,message]);
    expect(journal.conversation().messages).toHaveLength(2);
    journal.replace([{role:"user",content:"replacement",timestamp:3}]);
    journal.close();
    const reopened = new CoreJournal(directory,"pi","root",directory);
    expect(reopened.conversation().messages).toEqual([{role:"user",content:"replacement",timestamp:3}]);
    expect(readFileSync(reopened.portableFile,"utf8")).toContain("again");
    reopened.close();
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

it("retains tool records and prior messages when importing a native branched session", () => {
  const directory = mkdtempSync(join(tmpdir(), "core-import-"));
  try {
    const path = join(directory,"native.jsonl");
    writeFileSync(path,[
      {type:"session",id:"session"},
      {type:"message",id:"a",parentId:null,message:{role:"user",content:"first"}},
      {type:"message",id:"abandoned",parentId:"a",message:{role:"assistant",content:"discarded"}},
      {type:"message",id:"b",parentId:"a",message:{role:"toolResult",toolCallId:"call",content:"actual output"}},
      {type:"compaction",id:"c",parentId:"b",summary:"native checkpoint"},
    ].map(value=>JSON.stringify(value)).join("\n")+"\n");
    expect(readPortableConversation(path,"pi").messages).toEqual([
      {role:"user",content:"first"},{role:"toolResult",toolCallId:"call",content:"actual output"},
    ]);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
