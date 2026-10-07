import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { PromptOutbox, type OutboxResult, type PromptOutboxScope, type PromptOutboxTransport } from "./src/prompt-outbox";
import { PromptSubmissions } from "./src/prompt-submissions";

function value<T>(result: OutboxResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture() {
  const scope: PromptOutboxScope = { person: "person-a", environment: "local", bootstrap: "https://router.example/pi-stack/" };
  return new PromptOutbox({ scope, currentScope: () => scope, database: new IDBFactory() });
}

async function save(outbox: PromptOutbox) {
  const requestId = crypto.randomUUID();
  value(await outbox.enqueue("thread", { requestId, text: "Saved prompt", delivery: "steer" }));
  return requestId;
}

const accepted = { status: 202, body: { accepted: true, workId: "durable-admission", delivery: "steer" } };

test("HTTP coalescing alone reproduces the second handler's not_found acknowledgement", async () => {
  const outbox = fixture();
  const acceptance = gate();
  const started = gate();
  try {
    const requestId = await save(outbox);
    let transports = 0;
    let handlers = 0;
    const transport: PromptOutboxTransport = async () => {
      transports++;
      started.release();
      await acceptance.promise;
      return accepted;
    };
    const submitAndAcknowledge = async () => {
      const entry = value(await outbox.submit(requestId, transport));
      expect(entry.outcome.kind).toBe("accepted");
      handlers++;
      return outbox.acknowledge(requestId);
    };
    const first = submitAndAcknowledge();
    await started.promise;
    const second = submitAndAcknowledge();
    acceptance.release();
    const results = await Promise.all([first, second]);
    expect(transports).toBe(1);
    expect(handlers).toBe(2);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([
      { ok: false, error: { kind: "not_found", message: expect.any(String) } },
    ]);
  } finally {
    acceptance.release();
    outbox.dispose();
  }
}, 2_000);

test("send and healthy-feed overlap share transport, terminal handling and acknowledgement", async () => {
  const outbox = fixture();
  const submissions = new PromptSubmissions();
  const acceptance = gate();
  const transportStarted = gate();
  const handlerStarted = gate();
  const finishHandler = gate();
  const acknowledgementStarted = gate();
  const finishAcknowledgement = gate();
  try {
    const requestId = await save(outbox);
    let transports = 0;
    let handlers = 0;
    const acknowledgements: OutboxResult<void>[] = [];
    const operation = async () => {
      const entry = value(await outbox.submit(requestId, async () => {
        transports++;
        transportStarted.release();
        await acceptance.promise;
        return accepted;
      }));
      expect(entry.outcome).toEqual({ kind: "accepted", workId: "durable-admission" });
      handlers++;
      handlerStarted.release();
      await finishHandler.promise;
      acknowledgementStarted.release();
      await finishAcknowledgement.promise;
      const result = await outbox.acknowledge(requestId);
      acknowledgements.push(result);
      value(result);
    };
    const send = submissions.run(outbox, requestId, operation);
    await transportStarted.promise;
    const healthyFeed = submissions.run(outbox, requestId, operation);
    acceptance.release();
    await handlerStarted.promise;
    const duringTerminalHandling = submissions.run(outbox, requestId, operation);
    finishHandler.release();
    await acknowledgementStarted.promise;
    const duringAcknowledgement = submissions.run(outbox, requestId, operation);
    finishAcknowledgement.release();
    await Promise.all([send, healthyFeed, duringTerminalHandling, duringAcknowledgement]);
    expect(transports).toBe(1);
    expect(handlers).toBe(1);
    expect(acknowledgements).toEqual([{ ok: true, value: undefined }]);
    expect(value(await outbox.list())).toEqual([]);
  } finally {
    acceptance.release();
    finishHandler.release();
    finishAcknowledgement.release();
    outbox.dispose();
  }
}, 2_000);

test("a pending result releases the key so a later overlapping retry can accept and acknowledge", async () => {
  const outbox = fixture();
  const submissions = new PromptSubmissions();
  try {
    const requestId = await save(outbox);
    let transports = 0;
    let handlers = 0;
    let acknowledgements = 0;
    for (const response of [{ status: 503, body: { error: "Owner unavailable" } }, accepted]) {
      const acceptance = gate();
      const started = gate();
      try {
        const operation = async () => {
          const entry = value(await outbox.submit(requestId, async () => {
            transports++;
            started.release();
            await acceptance.promise;
            return response;
          }));
          handlers++;
          if (entry.outcome.kind === "accepted") {
            value(await outbox.acknowledge(requestId));
            acknowledgements++;
          } else {
            expect(entry.outcome.kind).toBe("pending");
          }
        };
        const first = submissions.run(outbox, requestId, operation);
        await started.promise;
        const second = submissions.run(outbox, requestId, operation);
        acceptance.release();
        await Promise.all([first, second]);
        if (response.status === 503) {
          expect(value(await outbox.list())).toMatchObject([{ requestId, outcome: { kind: "pending" } }]);
          expect(acknowledgements).toBe(0);
        }
      } finally {
        acceptance.release();
      }
    }
    expect(transports).toBe(2);
    expect(handlers).toBe(2);
    expect(acknowledgements).toBe(1);
    expect(value(await outbox.list())).toEqual([]);
  } finally {
    outbox.dispose();
  }
}, 2_000);

test("different owners and different request IDs run in parallel without joining each other", async () => {
  const submissions = new PromptSubmissions();
  const firstOwner = {};
  const secondOwner = {};
  const finish = gate();
  const starts = [gate(), gate(), gate()];
  const calls = [0, 0, 0];
  const keys = [[firstOwner, "same-request"], [secondOwner, "same-request"], [firstOwner, "other-request"]] as const;
  try {
    const operations = keys.map(([owner, requestId], index) => {
      const operation = async () => {
        calls[index] = calls[index]! + 1;
        starts[index]!.release();
        await finish.promise;
      };
      return [submissions.run(owner, requestId, operation), submissions.run(owner, requestId, operation)];
    }).flat();
    await Promise.all(starts.map(start => start.promise));
    expect(calls).toEqual([1, 1, 1]);
    finish.release();
    await Promise.all(operations);
  } finally {
    finish.release();
  }
}, 2_000);

test("shared asynchronous failure reaches both callers and releases the key for recovery", async () => {
  const submissions = new PromptSubmissions();
  const owner = {};
  const started = gate();
  const finish = gate();
  const failure = new Error("Terminal handling failed");
  let calls = 0;
  try {
    const operation = async () => {
      calls++;
      started.release();
      await finish.promise;
      throw failure;
    };
    const first = submissions.run(owner, "request", operation);
    await started.promise;
    const second = submissions.run(owner, "request", operation);
    const settled = Promise.allSettled([first, second]);
    finish.release();
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await submissions.run(owner, "request", async () => { calls++; });
    expect(calls).toBe(2);
  } finally {
    finish.release();
  }
}, 2_000);

test("a synchronous callback failure also releases the key", async () => {
  const submissions = new PromptSubmissions();
  const owner = {};
  const failure = new Error("Handler failed before returning a promise");
  let recovered = false;
  await expect(submissions.run(owner, "request", () => { throw failure; })).rejects.toBe(failure);
  await submissions.run(owner, "request", async () => { recovered = true; });
  expect(recovered).toBe(true);
}, 2_000);
