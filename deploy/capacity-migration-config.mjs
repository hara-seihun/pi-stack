#!/usr/bin/env node
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function migrationConfiguration(authority, client, host) {
  if (typeof host !== 'string' || !host || !Array.isArray(authority?.owners) || !Array.isArray(client?.owners))
    throw Error('Explicit host and registered authority/client owners required');
  const owners = authority.owners.filter(owner => owner.host === host).map(owner => owner.id);
  const root = client.owners.filter(owner => owner.uid === 0);
  if (!owners.length || new Set(owners).size !== owners.length || root.length !== 1 || !owners.includes(root[0].ownerId)
    || client.owners.length !== owners.length || new Set(client.owners.map(owner => owner.ownerId)).size !== owners.length
    || client.owners.some(owner => !owners.includes(owner.ownerId))) throw Error('Exact same-host owner inventory and registered root UID required');
  const grant = { ownerId: root[0].ownerId, ownerIds: owners };
  const migrations = authority.migrations === undefined ? [] : authority.migrations;
  if (!Array.isArray(migrations)) throw Error('Invalid existing migration grants');
  return { authority: { ...authority, migrations: [...migrations.filter(existing => existing.ownerId !== grant.ownerId), grant] },
    client: { ...client, migration: grant } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host, authorityPath, clientPath, stage] = process.argv.slice(2);
  if (process.argv.length !== 6 || ![authorityPath, clientPath, stage].every(path => typeof path === 'string' && isAbsolute(path)))
    throw Error('usage: capacity-migration-config.mjs HOST ABS_AUTHORITY_CONFIG ABS_CLIENT_CONFIG ABS_STAGE_DIRECTORY');
  for (const path of [authorityPath, clientPath]) {
    const stat = statSync(path);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw Error('Capacity configuration must have protected root custody');
  }
  const result = migrationConfiguration(JSON.parse(readFileSync(authorityPath, 'utf8')), JSON.parse(readFileSync(clientPath, 'utf8')), host);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const staged = statSync(stage);
  if (staged.uid !== 0 || (staged.mode & 0o077)) throw Error('Stage must be a private root-owned directory');
  writeFileSync(join(stage, 'authority.json'), JSON.stringify(result.authority, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(stage, 'client.json'), JSON.stringify(result.client, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ protocol: 'pi-capacity-migration-config-v1', state: 'staged', host, ownerCount: result.client.migration.ownerIds.length, stage }));
}
