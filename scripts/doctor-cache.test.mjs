import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { doctorDigest } from '../deploy/doctor-cache.mjs';

function fixture(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-command-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'deploy')); mkdirSync(join(root, 'packages/runtime'), { recursive: true });
  for (const file of ['runtime-doctors', 'lib', 'release-checkout', 'doctor-cache.mjs', 'prepared-components.mjs']) copyFileSync(new URL(`../deploy/${file}`, import.meta.url), join(root, 'deploy', file));
  const runtime = join(root, 'runtime'), home = join(root, 'home'), cache = join(root, 'proofs');
  mkdirSync(join(runtime, 'node_modules'), { recursive: true }); mkdirSync(join(home, '.pi/agent'), { recursive: true });
  writeFileSync(join(home, '.pi/agent/settings.json'), '{"packages":[]}');
  const probe = join(root, 'packages/runtime/browser-doctor.mjs');
  writeFileSync(probe, source);
  const trace = join(root, 'trace'), user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  const run = (exit, extra = {}) => spawnSync('bash', [join(root, 'deploy/runtime-doctors'), 'browser', root, user, root], { encoding: 'utf8', timeout: 3000, env: { ...process.env, PI_STACK_HOME_OVERRIDE: home, PI_STACK_DEPLOY_NO_SUDO: '1', PI_STACK_RUNTIME_DEST: runtime, PI_STACK_DOCTOR_CACHE_ROOT: cache, TEST_EXIT: String(exit), TRACE: trace, ...extra } });
  return { root, runtime, home, cache: join(cache, user), probe, trace, run };
}

test('only a successful exact doctor command earns reusable proof; changed probe source runs again', t => {
  const { run, trace, cache, probe } = fixture(t, `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.TRACE, 'doctor\\n'); process.exit(Number(process.env.TEST_EXIT));`);
  assert.equal(run(42).status, 42);
  const passed = run(0); assert.equal(passed.status, 0, passed.stderr);
  const reused = run(42); assert.equal(reused.status, 0, reused.stderr); assert.match(reused.stdout, /proof reused/);
  assert.equal(readFileSync(trace, 'utf8'), 'doctor\ndoctor\n');
  assert.equal(readdirSync(cache).length, 1);
  writeFileSync(probe, readFileSync(probe, 'utf8') + '\n// changed probe contract\n');
  assert.equal(run(42).status, 42);
  assert.equal(readdirSync(cache).length, 1, 'failed new probe cannot acquire a success receipt');
});

test('selection rollback does not rebind a running doctor; next invocation proves the newly selected inputs', t => {
  const f = fixture(t, `import assert from 'node:assert/strict'; import {readFileSync,unlinkSync,symlinkSync,appendFileSync} from 'node:fs';
    const bound=JSON.parse(readFileSync(process.env.PI_STACK_DOCTOR_BINDINGS));
    assert.equal(process.env.PI_STACK_RUNTIME_DEST,bound.runtime);
    assert.equal(readFileSync(bound.packages[0]+'/extension.js','utf8'),'candidate');
    if(process.env.TEST_EXIT==='0'){unlinkSync(process.env.SELECTED);symlinkSync(process.env.OLD,process.env.SELECTED);}
    assert.equal(readFileSync(bound.packages[0]+'/extension.js','utf8'),'candidate');
    appendFileSync(process.env.TRACE,'doctor\\n');process.exit(Number(process.env.TEST_EXIT));`);
  const candidate=join(f.root,'candidate'), old=join(f.root,'old'), selected=join(f.root,'selected');
  for (const [path, bytes] of [[candidate,'candidate'],[old,'old']]) { mkdirSync(path); writeFileSync(join(path,'extension.js'),bytes); }
  symlinkSync(candidate,selected);
  writeFileSync(join(f.home,'.pi/agent/settings.json'),JSON.stringify({packages:[selected]}));
  const result=f.run(0,{SELECTED:selected,OLD:old});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readdirSync(f.cache).length,1);
  const next=f.run(42,{SELECTED:selected,OLD:old});
  assert.notEqual(next.status,0,'old selected source cannot reuse candidate proof');
  assert.equal(readdirSync(f.cache).length,1);
});

test('privileged capture transfers a private capsule to the doctor account and removes it after proof', t => {
  if (process.getuid() !== 0 && spawnSync('sudo', ['-n', 'true']).status !== 0) { t.skip('root or passwordless sudo required for UID-crossing proof'); return; }
  const f=fixture(t, `import assert from 'node:assert/strict'; import {readFileSync,statSync,appendFileSync} from 'node:fs';
    const path=process.env.PI_STACK_DOCTOR_BINDINGS, info=statSync(path);
    assert.equal(info.uid,process.getuid());assert.equal(info.mode&0o777,0o600);
    assert.equal(JSON.parse(readFileSync(path)).runtime,process.env.PI_STACK_RUNTIME_DEST);
    appendFileSync(process.env.TRACE,path+'\\n');process.exit(Number(process.env.TEST_EXIT));`);
  mkdirSync(f.cache,{recursive:true});
  const env={PI_STACK_DEPLOY_NO_SUDO:'0'};
  const result=f.run(0,env);
  assert.equal(result.status,0,result.stderr);
  const capsule=readFileSync(f.trace,'utf8').trim();
  assert.equal(existsSync(capsule),false,'successful proof removes private capsule');
  const reused=f.run(42,env);assert.equal(reused.status,0,reused.stderr);assert.match(reused.stdout,/proof reused/);
  writeFileSync(f.probe,readFileSync(f.probe,'utf8')+'\n// new proof input\n');
  const failed=f.run(42,env);assert.equal(failed.status,42,failed.stderr);
  const failedCapsule=readFileSync(f.trace,'utf8').trim().split('\n')[1];
  assert.equal(existsSync(failedCapsule),false,'failed proof also removes private capsule');
  assert.equal(readdirSync(f.cache).length,1,'failure cannot acquire another receipt');
});

test('doctor closure identity follows executable bytes across generation paths and external links', t => {
  const root=mkdtempSync(join(tmpdir(),'doctor-content-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cache=join(root,'cache');
  const a=join(root,'generation-a'),b=join(root,'generation-b');
  for(const path of [a,b]) {
    mkdirSync(join(path,'node_modules/.bin'),{recursive:true});
    mkdirSync(join(path,'node_modules/jiti/lib'),{recursive:true});
    writeFileSync(join(path,'node_modules/jiti/lib/jiti-cli.mjs'),'same executable');
    writeFileSync(join(path,'.pi-stack-commit'),path);
    symlinkSync('../jiti/lib/jiti-cli.mjs',join(path,'node_modules/.bin/jiti'));
  }
  assert.equal(doctorDigest(a,cache),doctorDigest(b,cache),'dependency generation coordinates and release marker do not change code identity');
  const external=join(root,'external');mkdirSync(external);writeFileSync(join(external,'entry.mjs'),'first');
  symlinkSync(external,join(a,'external'));symlinkSync(external,join(b,'external'));
  const before=doctorDigest(a,cache);assert.equal(before,doctorDigest(b,cache));
  writeFileSync(join(external,'entry.mjs'),'changed');
  assert.notEqual(doctorDigest(a,cache),before,'mutation of linked executable bytes invalidates the memoized input');
  writeFileSync(join(b,'node_modules/jiti/lib/jiti-cli.mjs'),'changed executable');
  assert.notEqual(doctorDigest(a,cache),doctorDigest(b,cache),'changed SDK executable cannot acquire source equivalence');
});

test('mutating bytes of the captured package refuses successful-command proof', t => {
  const f=fixture(t, `import {readFileSync,writeFileSync} from 'node:fs';
    const bound=JSON.parse(readFileSync(process.env.PI_STACK_DOCTOR_BINDINGS));
    writeFileSync(bound.packages[0]+'/extension.js','mutated');`);
  const candidate=join(f.root,'candidate');mkdirSync(candidate);writeFileSync(join(candidate,'extension.js'),'candidate');
  writeFileSync(join(f.home,'.pi/agent/settings.json'),JSON.stringify({packages:[candidate]}));
  const result=f.run(0);
  assert.equal(result.status,66,result.stderr);
  assert.match(result.stderr,/inputs changed during proof/);
  assert.equal(existsSync(f.cache),false);
});
