#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForVoiceRoutes(routes, expected, budgetMs, fetcher) {
  if (!Array.isArray(routes) || !routes.every(route => route && typeof route.user === 'string' && /^[a-z_][a-z0-9_-]*$/.test(route.user)
    && typeof route.url === 'string' && /^http:\/\/127\.0\.0\.1:[0-9]+\/v1\/voice$/.test(route.url))
    || new Set(routes.map(route => route.user)).size !== routes.length || typeof expected !== 'string' || !/^[a-f0-9]{40}$/.test(expected)
    || !Number.isSafeInteger(budgetMs) || budgetMs <= 0 || typeof fetcher !== 'function')
    return { ok: false, error: { code: 'invalid_request', message: 'Voice readiness requires bound loopback routes, commit, positive deadline and fetch transport' } };
  const deadline = Date.now() + budgetMs;
  const pending = new Map(routes.map(route => [route.user, route]));
  while (pending.size && Date.now() < deadline) {
    const failures = await Promise.all([...pending.values()].map(async route => {
      let response;
      try { response = await fetcher(route.url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) }); }
      catch { return null; }
      if ([502, 503, 504].includes(response.status)) { await response.body?.cancel(); return null; }
      if (!response.ok) return { code: 'invalid_response', message: `${route.user}: Voice route returned HTTP ${response.status}` };
      let body;
      try { body = await response.json(); }
      catch { return { code: 'invalid_response', message: `${route.user}: Voice route returned invalid JSON` }; }
      if (body?.enabled !== true || body?.releaseCommit !== expected)
        return { code: 'release_mismatch', message: `${route.user}: Voice route does not serve enabled release ${expected}` };
      pending.delete(route.user);
      return null;
    }));
    const failure = failures.find(value => value !== null);
    if (failure) return { ok: false, error: failure };
    if (pending.size && Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()));
  }
  return pending.size ? { ok: false, error: { code: 'unavailable', message: `Voice routes not ready within ${budgetMs}ms: ${[...pending.keys()].join(', ')}` } }
    : { ok: true, value: { releaseCommit: expected, users: routes.map(route => route.user) } };
}

async function main(args) {
  const [router, persons, expected] = args;
  if (args.length !== 3 || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(router) || !persons.startsWith('/') || !/^[a-f0-9]{40}$/.test(expected))
    throw new Error('Usage: voice-routes-ready.mjs ROUTER_LOOPBACK_ORIGIN PERSONS_DIRECTORY COMMIT');
  const response = await fetch(`${router}/v1/router-health`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Router census returned HTTP ${response.status}`);
  const census = await response.json();
  if (!Array.isArray(census.people) || !census.people.every(person => person && typeof person.user === 'string'
    && /^[a-z_][a-z0-9_-]*$/.test(person.user) && typeof person.unlocked === 'boolean')
    || new Set(census.people.map(person => person.user)).size !== census.people.length)
    throw new Error('Router census has no valid people list');
  const routes = census.people.filter(person => person.unlocked === true).map(person => {
    if (!/^[a-z_][a-z0-9_-]*$/.test(person.user)) throw new Error('Router census has an invalid person identity');
    const record = JSON.parse(readFileSync(join(persons, `${person.user}.json`), 'utf8'));
    if (record.user !== person.user || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535)
      throw new Error(`Invalid supervisor binding for ${person.user}`);
    return { user: person.user, url: `http://127.0.0.1:${record.port}/v1/voice` };
  });
  const result = await waitForVoiceRoutes(routes, expected, 10_000, fetch);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
