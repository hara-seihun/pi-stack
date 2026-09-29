import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/src/meet/voice-playout.worklet.js", import.meta.url), "utf8");

function playout() {
  let Processor: new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    queued: number; discarded: number; underruns: number };
  runInNewContext(source, {
    sampleRate: 48_000,
    Float32Array,
    AudioWorkletProcessor: class { port = { postMessage() {} }; },
    registerProcessor(_name: string, constructor: typeof Processor) { Processor = constructor; },
  });
  return new Processor!();
}

test("the output clock primes briefly, then carries one continuous input sample sequence", () => {
  const node = playout();
  const heard: number[] = [];
  for (let block = 0; block < 80; block++) {
    const input = new Float32Array(128).fill(block + 1);
    const output = new Float32Array(128);
    node.process([[input]], [[output]]);
    heard.push(output[0]!);
  }
  expect(heard.slice(0, 22)).toEqual(Array(22).fill(0));
  expect(heard.slice(22, 80)).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
  expect(node.underruns).toBe(0);
  expect(node.discarded).toBe(0);
  expect(node.queued).toBeLessThanOrEqual(2_880);
});

test("stale audio is bounded instead of building a delayed reply", () => {
  const node = playout();
  node.process([[new Float32Array(48_000).fill(1)]], [[new Float32Array(128)]]);
  expect(node.discarded).toBeGreaterThan(40_000);
  expect(node.queued).toBeLessThanOrEqual(2_880);
  const output = new Float32Array(128);
  node.process([[new Float32Array(128).fill(2)]], [[output]]);
  expect(output[0]).toBe(1);
  expect(node.queued).toBeLessThanOrEqual(2_880);
});
