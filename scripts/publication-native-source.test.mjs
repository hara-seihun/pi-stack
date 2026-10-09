import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicationConfig } from './publication-fixture.mjs';
const publication = new URL('../deploy/publication', import.meta.url).href;

test('retained native repair fences already-checked source before host effects, while original restore stays source-bound', t => {
  const root = mkdtempSync(join(tmpdir(), 'publication-native-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repository'); mkdirSync(repo); mkdirSync(join(repo, 'deploy'));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  const trace = join(root, 'host-effects');
  writeFileSync(join(repo, 'deploy/native-history-boundary'), `printf '%s\\n' "$4" >> ${JSON.stringify(trace)}\n`);
  writeFileSync(join(repo, 'deploy/native-history-bridge.mjs'), 'export const protocol = "old";');
  git('add', '.'); git('commit', '-qm', 'checked old source'); const candidate = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'owner metadata only'); const equivalent = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'deploy/native-history-bridge.mjs'), 'export const protocol = "repaired";');
  git('add', '.'); git('commit', '-qm', 'repair native handoff'); const repaired = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pi-stack-publication/owner-source', repaired);
  const config = publicationConfig(root, repo);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {nativeMaintenanceSourceProof,nativeHistoryBoundaryTarget} from ${JSON.stringify(publication)};
    const candidate=${JSON.stringify(candidate)}, equivalent=${JSON.stringify(equivalent)}, repaired=${JSON.stringify(repaired)};
    assert.equal(nativeMaintenanceSourceProof(${JSON.stringify(repo)},candidate,equivalent).ok,true);
    assert.equal(nativeMaintenanceSourceProof(${JSON.stringify(repo)},candidate,repaired).error.code,'obsolete-native-maintenance-source');
    const request={requestId:'PUB-aaaaaaaaaaaaaaaaaaaaaaaa',integrationSha:candidate,integratedAt:'already-published-to-main',checks:{status:'passed'}};
    const target={id:'gmktec',sshHost:null,hostConfig:'/fixture/host.json',releaseRepository:${JSON.stringify(repo)}};
    assert.throws(()=>nativeHistoryBoundaryTarget(request,target,'advance'),/retained owner repair/);
    assert.throws(()=>nativeHistoryBoundaryTarget(request,target,'probe'),/retained owner repair/);
    assert.equal(request.nativeHistory,undefined);
    assert.equal(nativeHistoryBoundaryTarget(request,target,'restore').ok,true);
  `], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: config } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(trace), true); assert.equal(readFileSync(trace, 'utf8'), '--restore\n');
});
