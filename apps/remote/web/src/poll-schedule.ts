export interface PollSchedule {
  requestImmediate(): void;
  takeWaitMs(): number;
}

export function createPollSchedule(longPollMs = 25_000): PollSchedule {
  let immediate = true;
  return {
    requestImmediate() {
      immediate = true;
    },
    takeWaitMs() {
      const waitMs = immediate ? 0 : longPollMs;
      immediate = false;
      return waitMs;
    },
  };
}
