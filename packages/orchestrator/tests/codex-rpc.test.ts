import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodexRpc } from "../src/cores/codex-rpc.js";
import { credentialGuard } from "../src/cores/codex-auth.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function executable(body: string) {
  const root = mkdtempSync(join(tmpdir(), "codex-wire-")); roots.push(root);
  const path = join(root, "fixture.mjs");
  writeFileSync(path, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nconst send = value => process.stdout.write(JSON.stringify(value)+'\\n');\n${body}`);
  chmodSync(path, 0o700);
  return { root, path };
}
it("correlates split stdio frames and server auth requests without forwarding credentials or stderr", async () => {
  const { root, path } = executable(`
let requestId;
createInterface({input:process.stdin}).on('line', line => {
 const value = JSON.parse(line);
 if(value.method === 'initialize') {
   requestId = value.id;
   process.stderr.write('never-log-this-token');
   const frame = JSON.stringify({id:'refresh',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized'}})+'\\n';
   process.stdout.write(frame.slice(0,17)); process.stdout.write(frame.slice(17));
 } else if(value.id === 'refresh') {
   if(value.result.accessToken !== 'never-log-this-token') process.exit(2);
   send({method:'turn/started',params:{threadId:'root',turn:{id:'turn'}}});
   send({id:requestId,result:{accepted:true}});
 } else if(value.method === 'account/login/start') {
   send({id:value.id,error:{message:'never-log-this-token'}});
 }
});`);
  const notifications: unknown[] = [];
  const rpc = openCodexRpc({ cwd: root, env: process.env, binary: path,
    notification: (method, params) => notifications.push({ method, params }),
    serverRequest: async () => ({ ok: true, value: { accessToken: "never-log-this-token", chatgptAccountId: "account" } }), exit() {},
  });
  try {
    expect(await rpc.request("initialize", {})).toEqual({ ok: true, value: { accepted: true } });
    expect(notifications).toEqual([{ method: "turn/started", params: { threadId: "root", turn: { id: "turn" } } }]);
    expect(await rpc.request("account/login/start", {})).toEqual({ ok: false, error: "Codex rejected account/login/start" });
  } finally { await rpc.close(); }
});

it("preserves useful sanitized protocol errors and fails pending calls on process exit", async () => {
  const { root, path } = executable(`createInterface({input:process.stdin}).on('line', line => {
const value=JSON.parse(line);
if(value.method==='thread/turns/list') send({id:value.id,error:{message:'not materialized, token-secret'}});
else process.exit(3);
});`);
  const guard = credentialGuard(); guard.remember({ accessToken: "token-secret", chatgptAccountId: "account-secret" });
  const rpc = openCodexRpc({ cwd: root, env: process.env, binary: path, sanitizeError: text => guard.clean(text),
    notification() {}, serverRequest: async () => ({ ok: false, error: "unsupported" }), exit() {},
  });
  try {
    expect(await rpc.request("thread/turns/list", {})).toEqual({ ok: false, error: "Codex rejected thread/turns/list: not materialized, [redacted]" });
    expect(await rpc.request("turn/start", {})).toEqual({ ok: false, error: "Codex app-server exited during turn/start; outcome unknown" });
  } finally { await rpc.close(); }
});
