import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendCall, BackendConversation, BackendMessage, BackendSender, MessagingPlugin, MessagingPluginContext } from "./plugin";
import type { MessagingLink } from "./protocol";
import { createMessagingPlugin } from "./signal";

const account = "+12025550100";
const friend = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(script: string, options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "signal-plugin-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "signal-cli");
  await writeFile(binary, `#!${process.execPath}
import { createInterface } from 'node:readline';
const account = ${JSON.stringify(account)};
const friend = ${JSON.stringify(friend)};
const reply = (request, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
const receive = envelope => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'receive',params:{subscription:0,result:{account,envelope}}})+'\\n');
const incoming = (message, timestamp=101, extra={}) => receive({sourceUuid:friend,sourceNumber:'+12025550101',dataMessage:{timestamp,message,...extra}});
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  ${script}
  if(request.method==='listAccounts') return reply(request,[{number:account}]);
  if(request.method==='listContacts') return reply(request,[{uuid:friend,number:'+12025550101',name:'Friend'}]);
  if(request.method==='listGroups') return reply(request,[{id:'YWJjZA==',name:'Friends',isMember:true}]);
  if(request.method==='subscribeReceive') return reply(request,0);
  reply(request,{});
});
`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const statuses: Array<{ status: string; detail: string }> = [];
  const logs: string[] = [];
  const messages: BackendMessage[] = [];
  const reactions: import("./plugin").BackendReaction[] = [];
  const senders: BackendSender[] = [];
  const conversations: BackendConversation[] = [];
  const links: MessagingLink[] = [];
  const calls: BackendCall[] = [];
  const settled = deferred<MessagingLink>();
  const arrived = deferred<BackendMessage>();
  const { calls: enableCalls, ...profileOptions } = options;
  const plugin = createMessagingPlugin({ id: "signal", plugin: "signal", label: "Signal", options: { binary, callTunnelBinary: enableCalls ? binary : "/no-such-call-tunnel", ...profileOptions } });
  cleanups.push(() => plugin.close());
  const context: MessagingPluginContext = {
    dataDir: join(root, "profile"),
    conversation(value) { conversations.push(value); },
    sender(value) { senders.push(value); },
    self() {},
    async message(message) { messages.push(message); arrived.resolve(message); },
    async reaction(value) { reactions.push(value); },
    call(value) { calls.push(value); },
    status(status, detail) { statuses.push({ status, detail }); },
    log(message) { logs.push(message); },
    link(value) { links.push(value); if (value.status !== "waiting") settled.resolve(value); },
  };
  return { root, binary, plugin, context, statuses, logs, messages, reactions, senders, conversations, arrived, links, settled, calls };
}

async function start(plugin: MessagingPlugin, context: MessagingPluginContext) {
  const result = await plugin.start(context);
  expect(result).toEqual({ ok: true, value: undefined });
}

test("unlinked profiles stay unconfigured without linking or registration", async () => {
  const f = await fixture(`if(request.method==='listAccounts') return reply(request,[]);`);
  await start(f.plugin, f.context);
  expect(f.statuses.at(-1)?.status).toBe("unconfigured");
  expect((await f.plugin.openConversation("+12025550101")).ok).toBe(false);
});

test("missing signal-cli is an actionable unconfigured profile", async () => {
  const f = await fixture("", { binary: "/no-such-signal-cli" });
  expect(await f.plugin.start(f.context)).toMatchObject({ ok: false, error: { code: "unconfigured" } });
  expect(f.statuses.at(-1)).toMatchObject({ status: "unconfigured" });
  expect(f.statuses.at(-1)?.detail).toContain("Install signal-cli");
});

test("closing during startup does not spawn or revive the profile", async () => {
  const f = await fixture("");
  const starting = f.plugin.start(f.context);
  await f.plugin.close();
  expect(await starting).toMatchObject({ ok: false, error: { code: "closed" } });
  expect(f.statuses.some(value => value.status === "ready")).toBe(false);
});

const LINK_URI = "sgnl://linkdevice?uuid=test-uuid&pub_key=test-key";
const linkScript = (finish: string) => `
  if(request.method==='listAccounts' && !process.env.SIGNAL_TEST_LINKED) return reply(request,[]);
  if(request.method==='startLink') return reply(request,{deviceLinkUri:${JSON.stringify(LINK_URI)}});
  if(request.method==='finishLink') { ${finish} }
`;

test("an unlinked profile links from the app and reports the account it linked", async () => {
  const f = await fixture(linkScript(`
    if(request.params.deviceLinkUri!==${JSON.stringify(LINK_URI)} || request.params.deviceName!=='Martine phone') process.exit(4);
    return setTimeout(()=>reply(request,{number:account}),20);
  `));
  await start(f.plugin, f.context);
  expect(f.statuses.at(-1)?.status).toBe("unconfigured");
  const started = await f.plugin.startLink!("Martine phone");
  expect(started).toMatchObject({ ok: true, value: { status: "waiting", uri: LINK_URI, deviceName: "Martine phone", account: null } });
  if (!started.ok) return;
  expect(started.value.qr === null || started.value.qr.startsWith("<svg")).toBe(true);
  expect(await f.settled.promise).toMatchObject({ status: "linked", account, uri: null, error: null });
  expect(f.links.map(link => link.status)).toEqual(["waiting", "linked"]);
});

test("a waiting link is cancellable and reports no account", async () => {
  const f = await fixture(linkScript("return;"));
  await start(f.plugin, f.context);
  const started = await f.plugin.startLink!("PiStack");
  expect(started).toMatchObject({ ok: true, value: { status: "waiting" } });
  expect(await f.plugin.cancelLink!()).toMatchObject({ status: "cancelled", account: null, uri: null });
  expect(f.links.at(-1)?.status).toBe("cancelled");
});

test("a second link request reuses the waiting code instead of a second child", async () => {
  const f = await fixture(linkScript("return;"));
  await start(f.plugin, f.context);
  const first = await f.plugin.startLink!("PiStack");
  const second = await f.plugin.startLink!("Another name");
  expect(second).toEqual(first);
  expect(f.links.filter(link => link.status === "waiting")).toHaveLength(1);
});

test("a linked profile refuses to link a second account and closing ends a waiting link", async () => {
  const f = await fixture("");
  await start(f.plugin, f.context);
  expect(f.statuses.at(-1)?.status).toBe("ready");
  expect(await f.plugin.startLink!("PiStack")).toMatchObject({ ok: false, error: { code: "linked" } });
  const unlinked = await fixture(linkScript("return;"));
  await start(unlinked.plugin, unlinked.context);
  expect(await unlinked.plugin.startLink!("PiStack")).toMatchObject({ ok: true });
  await unlinked.plugin.close();
  expect(unlinked.links.at(-1)?.status).toBe("cancelled");
});

test("external daemon state cannot bypass encrypted profile ownership", async () => {
  const f = await fixture("", { dataDir: "/elsewhere" });
  expect(await f.plugin.start(f.context)).toMatchObject({ ok: false, error: { code: "configuration" } });
});

test("keeps child working state and temporary files inside the encrypted profile", async () => {
  const f = await fixture(`
    const state = process.argv[process.argv.indexOf('--data-dir')+1];
    if(process.cwd()!==state || !process.env.TMPDIR.startsWith(state+'/') || !process.env.XDG_CACHE_HOME.startsWith(state+'/') || !process.env.XDG_CONFIG_HOME.startsWith(state+'/')) process.exit(3);
  `);
  await start(f.plugin, f.context);
  expect(f.statuses.at(-1)?.status).toBe("ready");
});

test("discovers contacts and groups, sends named attachments, and uses matching sent-sync IDs", async () => {
  const f = await fixture(`
    if(request.method==='send') {
      if(request.params.recipient[0]!==friend || !request.params.attachments[0].includes('filename=hello.txt;base64,aGVsbG8=')) process.exit(2);
      reply(request,{timestamp:202,results:[{type:'SUCCESS'}]});
      receive({sourceNumber:account,syncMessage:{sentMessage:{destinationUuid:friend,timestamp:202,message:request.params.message}}});
      return;
    }
  `);
  await start(f.plugin, f.context);
  const group = await f.plugin.openConversation("group:YWJjZA==");
  expect(group).toMatchObject({ ok: true, value: { title: "Friends", kind: "group" } });
  const direct = await f.plugin.openConversation("+12025550101");
  expect(direct).toMatchObject({ ok: true, value: { id: friend } });
  if (!direct.ok) return;
  const path = join(f.root, "attachment");
  await writeFile(path, "hello");
  const sent = await f.plugin.send(direct.value, { requestId: "test", text: "Hi", attachments: [{ path, name: "hello.txt", mimeType: "text/plain", size: 5 }] });
  const sync = await f.arrived.promise;
  expect(sent).toEqual({ ok: true, value: { externalId: sync.id, timestamp: 202 } });
  expect(sync.direction).toBe("outgoing");
});

test("Signal reaction-only events use target author and timestamp, preserve group routing, and never become blank messages", async () => {
  const f = await fixture(`
    if(request.method==='subscribeReceive') {
      reply(request,0);
      receive({sourceUuid:friend,dataMessage:{timestamp:310,groupInfo:{groupId:'YWJjZA=='},reaction:{emoji:'👍',targetAuthor:account,targetSentTimestamp:202,isRemove:false}}});
      receive({sourceNumber:account,syncMessage:{sentMessage:{destinationUuid:friend,timestamp:311,reaction:{emoji:'👍',targetAuthor:friend,targetSentTimestamp:101,isRemove:true}}}});
      return;
    }
    if(request.method==='sendReaction') {
      if(request.params.targetAuthor!==account || request.params.targetTimestamp!==202 || !request.params.remove || request.params.groupId!=='YWJjZA==' || request.params.emoji!=='👍') process.exit(2);
      return reply(request,{timestamp:312,results:[{type:'SUCCESS'}]});
    }
  `);
  await start(f.plugin, f.context);
  expect(await f.plugin.react!({ id: 'group:YWJjZA==', title: 'Friends', kind: 'group' }, { author: 'You', timestamp: 202 }, '👍', true))
    .toEqual({ ok: true, value: { timestamp: 312, sender: account } });
  await f.plugin.close();
  expect(f.reactions).toEqual([
    expect.objectContaining({ target: { author: account, timestamp: 202 }, sender: friend, account, emoji: '👍', remove: false, conversation: expect.objectContaining({ id: 'group:YWJjZA==' }) }),
    expect.objectContaining({ target: { author: friend, timestamp: 101 }, sender: account, account, emoji: '👍', remove: true, conversation: expect.objectContaining({ id: friend }) }),
  ]);
  expect(f.messages).toHaveLength(0);
});

test("sender directory uses Signal nickname, contact and profile names, including hidden group members", async () => {
  const f = await fixture(`if(request.method==='listContacts') return reply(request,[
    {uuid:friend,number:'+12025550101',username:'friend.01',name:'Contact',nickName:'Nickname',profile:{givenName:'Profile'}},
    {uuid:'contact',name:'Address Book',profile:{givenName:'Profile'}},
    {uuid:'profile',isHidden:true,profile:{givenName:'Profile',familyName:'Only'}},
    {uuid:'unknown',number:'+12025550102',name:'  '}
  ]);`);
  await start(f.plugin, f.context);
  expect(f.senders).toEqual([
    { id: friend, aliases: [friend, '+12025550101', 'u:friend.01'], name: 'Nickname', avatar: null },
    { id: 'contact', aliases: ['contact'], name: 'Address Book', avatar: null },
    { id: 'profile', aliases: ['profile'], name: 'Profile Only', avatar: null },
    { id: 'unknown', aliases: ['unknown', '+12025550102'], name: null, avatar: null },
  ]);
  expect(f.conversations.some(value => value.id === 'profile')).toBe(false);
});

test("pictures signal-cli has fetched are offered by uuid, number or group id and refreshed on receive", async () => {
  const f = await fixture(`if(request.method==='listContacts') return reply(request,[
    {uuid:friend,number:'+12025550101',name:'Friend'},
    {number:'+12025550102',name:'By Number'},
    {uuid:'nobody',name:'No Picture'}
  ]);
  if(request.method==='subscribeReceive') { reply(request,0); receive({sourceUuid:friend,sourceNumber:'+12025550101',sourceName:'Friend',dataMessage:{timestamp:101,message:'hello'}}); return; }`);
  const avatars = join(f.context.dataDir, "signal-cli", "avatars");
  await mkdir(avatars, { recursive: true });
  await writeFile(join(avatars, `profile-${friend}`), "jpeg bytes");
  await writeFile(join(avatars, "profile-+12025550102"), "jpeg bytes");
  await writeFile(join(avatars, "group-YWJjZA=="), "png bytes");
  await writeFile(join(avatars, "profile-nobody"), "");
  await start(f.plugin, f.context);
  await f.arrived.promise;
  const picture = (value: { avatar?: { path: string; updatedAt: number } | null } | undefined) => value?.avatar ? { name: value.avatar.path.slice(avatars.length + 1), fresh: value.avatar.updatedAt > 0 } : value?.avatar;
  expect(picture(f.senders.find(value => value.id === friend))).toEqual({ name: `profile-${friend}`, fresh: true });
  expect(picture(f.senders.find(value => value.id === "+12025550102"))).toEqual({ name: "profile-+12025550102", fresh: true });
  expect(picture(f.senders.find(value => value.id === "nobody"))).toBeNull();
  expect(picture(f.conversations.find(value => value.id === friend))).toEqual({ name: `profile-${friend}`, fresh: true });
  expect(picture(f.conversations.find(value => value.id === "group:YWJjZA=="))).toEqual({ name: "group-YWJjZA==", fresh: true });
  // The receive-time sender update carries the picture too, so a contact whose photo landed after discovery still shows it.
  expect(picture(f.senders.at(-1))).toEqual({ name: `profile-${friend}`, fresh: true });
});

test("receive names update group authors without changing sender or replay identity", async () => {
  const f = await fixture(`if(request.method==='subscribeReceive') {
    reply(request,0);
    receive({sourceUuid:friend,sourceNumber:'+12025550101',sourceName:'Renamed'});
    incoming('group message',101,{groupInfo:{groupId:'YWJjZA=='}});
    receive({sourceUuid:friend,sourceNumber:'+12025550101',sourceName:'Latest Name',dataMessage:{timestamp:101,message:'group message',groupInfo:{groupId:'YWJjZA=='}}});
    return;
  }`);
  await start(f.plugin, f.context);
  await f.arrived.promise;
  await f.plugin.close();
  expect(f.messages).toHaveLength(2);
  expect(f.messages[0]).toMatchObject({ sender: friend, conversation: { kind: 'group' } });
  expect(f.messages[0].id).toBe(`${account}:${friend}:101`);
  expect(f.messages[1].id).toBe(f.messages[0].id);
  expect(f.senders.map(value => value.name)).toEqual(['Friend', 'Renamed', 'Latest Name']);
});

test("downloads received attachments into the profile and awaits the storage callback", async () => {
  const f = await fixture(`
    if(request.method==='subscribeReceive') {
      reply(request,0);
      incoming('Attached',303,{attachments:[{id:'file-id',filename:'note.txt',contentType:'text/plain'}]});
      return;
    }
    if(request.method==='getAttachment') return reply(request,{data:Buffer.from('secret').toString('base64')});
  `);
  const stored = deferred<void>();
  const release = deferred<void>();
  let file = "";
  f.context.message = async message => {
    file = message.attachments[0]!.path;
    expect(file.startsWith(f.context.dataDir + "/")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("secret");
    stored.resolve();
    await release.promise;
  };
  await start(f.plugin, f.context);
  await stored.promise;
  expect(await readFile(file, "utf8")).toBe("secret");
  release.resolve();
  await f.plugin.close();
  expect(await Bun.file(file).exists()).toBe(false);
});

test("close drains admitted attachment messages before terminating signal-cli", async () => {
  const f = await fixture(`
    if(request.method==='subscribeReceive') {
      reply(request,0);
      incoming('first',601);
      incoming('second',602,{attachments:[{id:'file-id',filename:'note.txt',contentType:'text/plain'}]});
      return;
    }
    if(request.method==='getAttachment') return reply(request,{data:Buffer.from('drained').toString('base64')});
  `);
  const first = deferred<void>();
  const release = deferred<void>();
  const saved: string[] = [];
  f.context.message = async message => {
    if (message.text === "first") { first.resolve(); await release.promise; }
    else expect(await readFile(message.attachments[0]!.path, "utf8")).toBe("drained");
    saved.push(message.text);
  };
  await start(f.plugin, f.context);
  await first.promise;
  const closing = f.plugin.close();
  release.resolve();
  await closing;
  expect(saved).toEqual(["first", "second"]);
});

test("transport close after dispatch settles sends as unknown", async () => {
  const f = await fixture(`if(request.method==='send') { incoming('dispatched'); return; }`);
  await start(f.plugin, f.context);
  const conversation = await f.plugin.openConversation(friend);
  if (!conversation.ok) throw new Error("missing fixture contact");
  const send = f.plugin.send(conversation.value, { requestId: "pending", text: "Hi", attachments: [] });
  await f.arrived.promise;
  await f.plugin.close();
  expect(await send).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("RPC rejections remain definite failures and send timeouts remain unknown", async () => {
  const f = await fixture(`if(request.method==='send') {
    if(request.params.message==='reject') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-4,message:'Untrusted identity'}})+'\\n');
    return;
  }`, { timeoutMs: 150 });
  await start(f.plugin, f.context);
  const conversation = await f.plugin.openConversation(friend);
  if (!conversation.ok) throw new Error("missing fixture contact");
  expect(await f.plugin.send(conversation.value, { requestId: "a", text: "reject", attachments: [] })).toMatchObject({ ok: false, error: { code: "signal_-4" } });
  expect(await f.plugin.send(conversation.value, { requestId: "b", text: "timeout", attachments: [] })).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("RPC network/internal errors and generic send failures are unknown", async () => {
  const f = await fixture(`if(request.method==='send') {
    const errors = {
      network:{code:-3,message:'Connection reset'},
      internal:{code:-32603,message:'Send failed (IOException)'},
      generic:{code:-1,message:'Failed to send message'},
      results:{code:-1,message:'Failed to send message',data:{response:{timestamp:701,results:[{type:'NETWORK_FAILURE'}]}}},
      rejected:{code:-1,message:'Failed to send message',data:{response:{timestamp:701,results:[{type:'UNREGISTERED_FAILURE'}]}}},
      validation:{code:-32602,message:'Invalid params'}
    };
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:errors[request.params.message]})+'\\n');
    return;
  }`);
  await start(f.plugin, f.context);
  const conversation = await f.plugin.openConversation(friend);
  if (!conversation.ok) throw new Error("missing fixture contact");
  for (const kind of ["network", "internal", "generic", "results"]) {
    expect(await f.plugin.send(conversation.value, { requestId: kind, text: kind, attachments: [] })).toMatchObject({ ok: false, error: { code: "unknown" } });
  }
  for (const [kind, code] of [["rejected", "signal_-1"], ["validation", "signal_-32602"]]) {
    expect(await f.plugin.send(conversation.value, { requestId: kind!, text: kind!, attachments: [] })).toMatchObject({ ok: false, error: { code } });
  }
});

test("group delivery distinguishes success, rejection and uncertainty with safe result counts", async () => {
  const f = await fixture(`if(request.method==='send') {
    const results = {
      sent:[{type:'SUCCESS'},{type:'SUCCESS'}],
      partial:[{type:'SUCCESS'},{type:'IDENTITY_FAILURE'}],
      rejected:[{type:'IDENTITY_FAILURE'}],
      network:[{type:'NETWORK_FAILURE'}],
      malformed:[{recipientAddress:'private-address'}],
      unfamiliar:[{type:'unrecognized-private-data'}]
    };
    return reply(request,{timestamp:500,results:results[request.params.message]});
  }`);
  await start(f.plugin, f.context);
  const group = await f.plugin.openConversation("group:YWJjZA==");
  if (!group.ok) throw new Error("missing fixture group");
  expect(await f.plugin.send(group.value, { requestId: "sent", text: "sent", attachments: [] })).toMatchObject({ ok: true, value: { timestamp: 500 } });
  const partial = await f.plugin.send(group.value, { requestId: "partial", text: "partial", attachments: [] });
  expect(partial).toMatchObject({ ok: false, error: { code: "unknown" } });
  if (!partial.ok) expect(partial.error.message).toContain('SUCCESS: 1, IDENTITY_FAILURE: 1');
  expect(await f.plugin.send(group.value, { requestId: "rejected", text: "rejected", attachments: [] })).toMatchObject({ ok: false, error: { code: "delivery" } });
  for (const text of ['network', 'malformed', 'unfamiliar']) {
    const result = await f.plugin.send(group.value, { requestId: text, text, attachments: [] });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown' } });
    if (!result.ok) {
      expect(result.error.message).toContain(text === 'network' ? 'NETWORK_FAILURE: 1' : 'UNRECOGNIZED_RESULT: 1');
      expect(result.error.message).not.toContain('private');
    }
  }
});

test("view-once and disappearing content is not retained as ordinary history", async () => {
  const f = await fixture(`if(request.method==='subscribeReceive') {
    reply(request,0);
    incoming('temporary',401,{expiresInSeconds:30});
    incoming('view once',402,{viewOnce:true});
    incoming('permanent',403);
    return;
  }`);
  await start(f.plugin, f.context);
  expect((await f.arrived.promise).text).toBe("permanent");
  expect(f.messages).toHaveLength(1);
  expect(f.statuses.filter(value => value.detail.includes("omitted"))).toHaveLength(2);
});

test("a child that stops answering becomes an error instead of a silent receive", async () => {
  const f = await fixture(`
    if(request.method==='listAccounts'&&globalThis.answered) return;
    if(request.method==='listAccounts'){ globalThis.answered=true; return reply(request,[{number:account}]); }
  `, { probeMs: 30, timeoutMs: 80 });
  await start(f.plugin, f.context);
  expect(f.statuses.at(-1)?.status).toBe("ready");
  await Bun.sleep(500);
  expect(f.statuses.at(-1)?.status).toBe("error");
  expect(f.statuses.at(-1)?.detail).toContain("stopped answering");
});

test("a receive subscription that goes quiet is rebuilt rather than trusted", async () => {
  const f = await fixture(`
    if(request.method==='subscribeReceive'){ globalThis.subscriptions=(globalThis.subscriptions||0)+1; return reply(request,globalThis.subscriptions); }
    if(request.method==='unsubscribeReceive') return reply(request,true);
  `, { probeMs: 30, silenceMs: 1 });
  await start(f.plugin, f.context);
  await Bun.sleep(300);
  expect(f.logs.some(line => line.includes("receive subscription rebuilt as 2"))).toBe(true);
  expect(f.statuses.at(-1)?.status).toBe("ready");
});

test("call events and command responses preserve unsigned 64-bit ids as strings", async () => {
  const incomingId = "9007199254740993";
  const outgoingId = "18446744073709551610";
  const f = await fixture(`
    if(request.method==='subscribeCallEvents') {
      if(process.env.SIGNAL_CALL_TUNNEL_AUDIO_MODE!=='pipe' || process.env.SIGNAL_CALL_TUNNEL_BIN!==process.argv[1] || !process.env.SIGNAL_CALL_TUNNEL_SOCKET_DIR.endsWith('/tmp')) process.exit(8);
      reply(request,7);
      process.stdout.write('{"jsonrpc":"2.0","method":"callEvent","params":{"subscription":7,"result":{"callId":${incomingId},"state":"RINGING_INCOMING","number":"+12025550101","uuid":"'+friend+'","isOutgoing":false,"inputDeviceName":"unix:/tmp/incoming.sock","outputDeviceName":"unix:/tmp/incoming.sock","reason":null}}}\\n');
      return;
    }
    if(request.method==='startCall') {
      if(request.params.recipient!==friend || Array.isArray(request.params.recipient)) process.exit(9);
      process.stdout.write('{"jsonrpc":"2.0","id":'+request.id+',"result":{"callId":${outgoingId},"state":"RINGING_OUTGOING","inputDeviceName":"unix:/tmp/outgoing.sock","outputDeviceName":"unix:/tmp/outgoing.sock"}}\\n');
      return;
    }
    if(request.method==='rejectCall') {
      if(request.params.callId!==${JSON.stringify(incomingId)}) process.exit(10);
      return reply(request,{});
    }
    if(request.method==='acceptCall') {
      if(request.params.callId!==${JSON.stringify(incomingId)}) process.exit(11);
      process.stdout.write('{"jsonrpc":"2.0","id":'+request.id+',"result":{"callId":${incomingId},"state":"CONNECTING","inputDeviceName":"unix:/tmp/incoming.sock","outputDeviceName":"unix:/tmp/incoming.sock"}}\\n');
      return;
    }
    if(request.method==='hangupCall') {
      if(request.params.callId!==${JSON.stringify(outgoingId)}) process.exit(12);
      return reply(request,{});
    }
    if(request.method==='unsubscribeCallEvents') return reply(request,true);
  `, { calls: true });
  await start(f.plugin, f.context);
  await Bun.sleep(10);
  expect(f.plugin.capabilities.calls).toBe(true);
  expect(f.calls[0]).toMatchObject({ externalId: incomingId, peer: friend, direction: "incoming", state: "ringing_incoming" });
  expect(await f.plugin.calls!.hangup(incomingId)).toMatchObject({ ok: true });
  expect(await f.plugin.calls!.accept(incomingId)).toMatchObject({ ok: true, value: { externalId: incomingId, state: "connecting" } });
  const started = await f.plugin.calls!.start(friend);
  expect(started).toMatchObject({ ok: true, value: { externalId: outgoingId, peer: friend, direction: "outgoing" } });
  expect(await f.plugin.calls!.hangup(outgoingId)).toMatchObject({ ok: true });
});

test("calling stays unavailable when the configured tunnel executable is missing", async () => {
  const f = await fixture("");
  expect(f.plugin.capabilities.calls).toBe(false);
  expect(f.plugin.calls).toBeUndefined();
});

test("signal-cli diagnostics reach the host log instead of an in-memory ring", async () => {
  const f = await fixture(`if(request.method==='listContacts') process.stderr.write('WARN WebSocket disconnected\\n');`);
  await start(f.plugin, f.context);
  await Bun.sleep(100);
  expect(f.logs.some(line => line === "signal-cli: WARN WebSocket disconnected")).toBe(true);
  expect(f.logs.some(line => line.startsWith("signal-cli started as pid "))).toBe(true);
  expect(f.logs.some(line => line.startsWith("receive subscription 0 is live"))).toBe(true);
});
