import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, statSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { componentScopes, sourceKeys } from './source-scopes.mjs';
import { digest } from './prepared-components.mjs';

function atomic(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o644 });
  renameSync(temporary, path);
}
export function componentCache(root, releases, commit, action) {
  try {
    if (!['reuse', 'record'].includes(action)) return { ok: false, error: { code: 'component-cache-operation-invalid' } };
    const keys = sourceKeys(root, commit, componentScopes);
    const result = {};
    for (const [component, key] of Object.entries(keys)) {
      const index = join(releases, '.prepared', '.components', component, `${key}.json`);
      const destination = join(releases, component, commit);
      if (action === 'record') {
        const receipt = JSON.parse(readFileSync(join(releases, '.prepared', `${commit}.json`), 'utf8'));
        const artifact = receipt.artifacts.find(item => item.component === component);
        if (!artifact || artifact.path !== destination) throw new Error(`Missing ${component} preparation`);
        atomic(index, { protocol: 'pi-component-cache-v1', component, key, commit, artifact });
        result[component] = 'recorded';
        continue;
      }
      if (existsSync(destination)) { result[component] = 'present'; continue; }
      if (!existsSync(index)) { result[component] = 'cold'; continue; }
      const saved = JSON.parse(readFileSync(index, 'utf8'));
      if (saved.protocol !== 'pi-component-cache-v1' || saved.component !== component || saved.key !== key ||
          sourceKeys(root, saved.commit, { [component]: componentScopes[component] })[component] !== key ||
          saved.artifact.path !== join(releases, component, saved.commit)) throw new Error(`Invalid ${component} cache identity`);
      if (!existsSync(saved.artifact.path)) { result[component] = 'collected'; continue; }
      if (digest(saved.artifact.path, join(releases, '.prepared', '.hashes')) !== saved.artifact.sha256) throw new Error(`Changed ${component} cache artifact`);
      mkdirSync(join(releases, component), { recursive: true, mode: 0o755 });
      const stage = `${destination}.${process.pid}.tmp`;
      try {
        execFileSync('cp', ['-al', saved.artifact.path, stage]);
        chmodSync(stage, statSync(stage).mode | 0o700);
        unlinkSync(join(stage, '.pi-stack-commit'));
        writeFileSync(join(stage, '.pi-stack-commit'), commit + '\n', { mode: 0o644 });
        chmodSync(join(stage, '.pi-stack-commit'), 0o644);
        if (component === 'runtime') {
          const path = join(stage, '.pi-stack-runtime-prepared.json');
          const proof = JSON.parse(readFileSync(path, 'utf8'));
          unlinkSync(path);
          writeFileSync(path, JSON.stringify({ ...proof, commit, candidate: destination, reusedFrom: saved.commit }) + '\n', { mode: 0o444 });
          chmodSync(stage, statSync(stage).mode & ~0o222);
        }
        if (component === 'remote' || component === 'tools') {
          const link = join(stage, 'node_modules/pi-orchestrator');
          if (existsSync(link)) {
            unlinkSync(link);
            // Keep the candidate import graph self-contained for retention.
            chmodSync(join(stage, 'node_modules'), statSync(join(stage, 'node_modules')).mode | 0o700);
            execFileSync('ln', ['-s', join(releases, 'orchestrator', commit), link]);
          }
        }
        if (component === 'remote') {
          for (const name of ['release-revision.js']) {
            const path = join(stage, 'web/dist', name);
            if (!existsSync(path)) continue;
            const html = readFileSync(path, 'utf8');
            const changed = html.replace(/globalThis\.__PI_STACK_RELEASE_REVISION__="[a-f0-9]{40}"/g, `globalThis.__PI_STACK_RELEASE_REVISION__="${commit}"`);
            if (html !== changed) {
              unlinkSync(path); writeFileSync(path, changed, { mode: 0o644 }); chmodSync(path, 0o644);
              for (const suffix of ['.gz', '.br']) if (existsSync(path + suffix)) unlinkSync(path + suffix);
            }
          }
        }
        renameSync(stage, destination);
      } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
      result[component] = 'reused';
    }
    return { ok: true, value: { keys, components: result } };
  } catch (error) { return { ok: false, error: { code: 'component-cache-invalid', message: String(error) } }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = componentCache(...process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 66;
}
