import { describe, expect, test } from "bun:test";
import { createPollSchedule } from "./src/poll-schedule";

describe("browser synchronization schedule", () => {
  test("checks immediately after startup and every requested reconciliation", () => {
    const schedule = createPollSchedule();

    expect(schedule.takeWaitMs()).toBe(0);
    expect(schedule.takeWaitMs()).toBe(25_000);

    schedule.requestImmediate();
    schedule.requestImmediate();
    expect(schedule.takeWaitMs()).toBe(0);
    expect(schedule.takeWaitMs()).toBe(25_000);
  });
});
