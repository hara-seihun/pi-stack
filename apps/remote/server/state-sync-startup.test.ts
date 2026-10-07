import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("state changes during held Meet bootstrap publish only after messaging is ready", async () => {
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const begin = source.indexOf("const STATE_COALESCE_MS =");
  const end = source.indexOf("// The Machine screen", begin);
  const ready = source.lastIndexOf('stateSyncPhase = "ready";');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  expect(ready).toBeGreaterThan(source.indexOf("const messaging ="));
  expect(source.indexOf("const messaging =")).toBeGreaterThan(source.indexOf("await MeetGateway.connect"));

  const queued: (() => void)[] = [];
  const published: string[] = [];
  let signal: () => void = () => { throw new Error("signal not exposed"); };
  let resume!: () => void;
  const bootstrap = new Promise<void>(resolve => { resume = resolve; });
  const program = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    return (async () => {
      let shuttingDown = false;
      ${source.slice(begin, end)}
      function refreshState() { publish(messaging.snapshot); }
      expose(signalSync);
      await bootstrap;
      const messaging = { snapshot: "initialized" };
      ${source.slice(ready)}
    })();
  `);
  const start = new Function("bootstrap", "expose", "setTimeout", "publish", program);
  const startup = start(bootstrap, (callback: () => void) => { signal = callback; }, (callback: () => void) => {
    queued.push(callback);
    return queued.length;
  }, (snapshot: string) => { published.push(snapshot); }) as Promise<void>;

  for (let burst = 0; burst < 3; burst++) {
    signal();
    await Promise.resolve();
    expect(queued).toHaveLength(0);
    expect(published).toHaveLength(0);
  }
  resume();
  await startup;
  expect(queued).toHaveLength(1);
  signal();
  expect(queued).toHaveLength(1);
  queued.shift()!();
  expect(published).toEqual(["initialized"]);
  signal();
  expect(queued).toHaveLength(1);
  queued.shift()!();
  expect(published).toEqual(["initialized", "initialized"]);
});
