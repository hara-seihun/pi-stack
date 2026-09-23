import type { Socket } from 'node:net';
import { shareFile } from '../shared-custody.js';
import { closeSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';

export class RuntimeOutput {
  private fd: number;
  sequence: number;
  private acknowledged: number;
  private acknowledgedOffset: number;
  private end: number;
  private ends: Map<number, number>;
  private client: {socket: Socket; offset: number; pumping: boolean} | null;
  private closed: boolean;
  constructor(path: string) {
    this.fd = openSync(path, 'ax+', 0o600);
    shareFile(this.fd);
    this.sequence = 0;
    this.acknowledged = 0;
    this.acknowledgedOffset = 0;
    this.end = 0;
    this.ends = new Map();
    this.client = null;
    this.closed = false;
  }

  publish(value: unknown) { this.publishLine(JSON.stringify(value)); }

  publishLine(line: string) {
    if (this.closed) return;
    const record = JSON.stringify({type: 'output', sequence: ++this.sequence, line}) + '\n';
    const bytes = Buffer.from(record);
    let written = 0;
    while (written < bytes.length) written += writeSync(this.fd, bytes, written, bytes.length - written);
    this.end += written;
    this.ends.set(this.sequence, this.end);
    this.pump();
  }

  attach(socket: Socket, after: number) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) throw new Error('Invalid runtime output cursor');
    const sequence = Math.max(after, this.acknowledged);
    const offset = sequence === this.acknowledged ? this.acknowledgedOffset : this.ends.get(sequence);
    if (offset === undefined) throw new Error('Runtime output cursor has no retained boundary');
    const client = {socket, offset, pumping: false};
    this.client = client;
    socket.once('close', () => { if (this.client === client) this.client = null; });
    this.pump();
  }

  acknowledge(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < this.acknowledged || sequence > this.sequence) return;
    if (sequence === this.acknowledged) return;
    const offset = this.ends.get(sequence);
    if (offset === undefined) throw new Error('Runtime acknowledgement has no retained boundary');
    for (let current = this.acknowledged + 1; current <= sequence; current++) this.ends.delete(current);
    this.acknowledged = sequence;
    this.acknowledgedOffset = offset;
    this.compact();
  }

  compact() {
    if (this.closed || this.acknowledged !== this.sequence || this.client?.pumping) return;
    ftruncateSync(this.fd, 0);
    this.end = 0;
    this.acknowledgedOffset = 0;
    if (this.client) this.client.offset = 0;
  }

  pump() {
    const client = this.client;
    if (!client || client.pumping || this.closed || client.offset === this.end) return;
    client.pumping = true;
    void (async () => {
      let buffer = Buffer.allocUnsafe(Math.min(64 * 1024, this.end - client.offset));
      while (!this.closed && this.client === client && client.socket.writable && !client.socket.destroyed && client.offset < this.end) {
        const size = Math.min(64 * 1024, this.end - client.offset);
        if (buffer.length < size) buffer = Buffer.allocUnsafe(size);
        const count = readSync(this.fd, buffer, 0, size, client.offset);
        if (!count) throw new Error('Runtime output spool ended before its committed boundary');
        client.offset += count;
        if (!client.socket.write(Buffer.from(buffer.subarray(0, count)))) await new Promise<void>(resolve => {
          const done = () => { client.socket.off('drain', done); client.socket.off('close', done); resolve(); };
          client.socket.once('drain', done);
          client.socket.once('close', done);
        });
      }
    })().catch(error => {
      console.error('Runtime output delivery failed:', error);
      client.socket.destroy();
    }).finally(() => {
      client.pumping = false;
      this.compact();
      if (this.client === client && !client.socket.destroyed && client.offset < this.end) this.pump();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
