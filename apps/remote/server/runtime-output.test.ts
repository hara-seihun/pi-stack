import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeOutput } from './runtime-output.mjs';

class Receiver extends EventEmitter {
  writable = true;
  destroyed = false;
  chunks: Buffer[] = [];
  write(chunk: Buffer) { this.chunks.push(Buffer.from(chunk)); return false; }
  destroy() { this.destroyed = true; this.writable = false; this.emit('close'); }
  async drain() { this.emit('drain'); await Promise.resolve(); }
  records() { return Buffer.concat(this.chunks).toString().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
}

test('one backpressured writer resumes at acknowledged record boundaries and reclaims its spool', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-output-'));
  const path = join(directory, 'events');
  const output = new RuntimeOutput(path);
  try {
    output.publish({text: 'first'});
    const first = new Receiver();
    output.attach(first, 0);
    output.acknowledge(1);
    output.publish({text: 'x'.repeat(200_000)});
    await first.drain();
    expect(first.destroyed).toBe(false);
    expect(Buffer.concat(first.chunks).length).toBeLessThan(100_000);
    first.destroy();
    const second = new Receiver();
    output.attach(second, 1);
    for (let i = 0; i < 8; i++) await second.drain();
    expect(second.records().map(event => event.sequence)).toEqual([2]);
    expect(JSON.parse(second.records()[0].line).text).toHaveLength(200_000);
    output.acknowledge(2);
    expect(statSync(path).size).toBe(0);
    output.publish({text: 'after truncation'});
    for (let i = 0; i < 4; i++) await second.drain();
    expect(second.records().map(event => event.sequence)).toEqual([2, 3]);
    output.acknowledge(3);
    expect(statSync(path).size).toBe(0);
  } finally { output.close(); rmSync(directory, {recursive: true, force: true}); }
});
