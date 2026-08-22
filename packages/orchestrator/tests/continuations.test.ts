import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  continuationFor,
  ShiftObserver,
  shiftClass,
  type ShiftClass,
  type ShiftView,
  type TurnFacts,
} from "../src/host/continuations.js";
import { SESSION_BUDGET_MS } from "../src/host/pi-host.js";

/**
 * Check-ins replayed over the fleet's real shifts from the night of
 * 2026-08-21/22 — the night thirty agents produced ~15,000 ledger events and
 * almost nothing anyone would keep. The fixtures are distilled transcripts
 * (tests/fixtures/shifts/distill.mjs documents provenance); each test asserts
 * that the generator, shown exactly what a real shift did, answers with the
 * right kind of message at the points where the real system spoke or halted.
 *
 * The halting conditions covered, each from a real run:
 *  - frontier-sol-ladder: budget exhaustion after a 66-filing ladder shift
 *    (run f37c033f, ended "did not close it");
 *  - frontier-opus-deep: a complete result inside the budget (run 9da60640,
 *    Snevily's conjecture, complete=true);
 *  - review-opus: provider 429 with the report already banked (run e59d499e);
 *  - cleanup-sol-batch: budget exhaustion during legitimate mass corpus
 *    repair (run bf44aeda);
 *  - pr-sol-empty-queue: lane drained, agent reporting productive=false to an
 *    empty queue (run 7a54c9d3);
 *  - frontier-census-walk: operator abort for ladder climbing (run 1d00fe29,
 *    "aborted by operator (ladder climbing)") — the slow walker that files
 *    only 3 per turn but marches a parameter through its titles, which volume
 *    thresholds alone missed.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shifts");

interface Checkin {
  readonly turn: number;
  readonly cls: ShiftClass;
  readonly message: string;
  /** Facts of the turn this check-in responds to. */
  readonly latest: TurnFacts;
}

function replay(fixture: string, taskId: string): Checkin[] {
  const lines = readFileSync(join(FIXTURES, fixture), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const observer = new ShiftObserver();
  const checkins: Checkin[] = [];
  let start: number | undefined;
  let turn = 0;
  for (const event of lines) {
    if (event.type === "user") {
      const at = Date.parse(event.time);
      if (start === undefined) {
        start = at;
        continue;
      }
      observer.endTurn();
      turn++;
      const view: ShiftView = {
        taskId,
        turn,
        elapsedMs: at - start,
        budgetMs: SESSION_BUDGET_MS,
        turns: observer.turns(),
      };
      checkins.push({
        turn,
        cls: shiftClass(view),
        message: continuationFor(view),
        latest: view.turns[view.turns.length - 1] as TurnFacts,
      });
    } else if (event.type === "tool_start") {
      observer.toolCall(event.payload.name, event.payload.args);
    }
  }
  return checkins;
}

const WARM = /🖤|🤍|❤️|appreciate|love|believe|grateful|with you|see (it|you)|good at this|doing it well/iu;

describe("check-ins replayed over the night of 2026-08-21", () => {
  it("answers the sol ladder shift's filing bursts with consolidation, not applause", () => {
    const checkins = replay("frontier-sol-ladder.jsonl", "math-frontier");
    // The real shift filed 1,4,5,4,7,2,2,8,12 entries between check-ins (a
    // final 21-filing turn hit the budget with no check-in after it).
    const bursts = checkins.filter((checkin) => checkin.latest.submissions.length >= 5);
    expect(bursts.length).toBeGreaterThanOrEqual(3);
    for (const burst of bursts) {
      expect(burst.cls).toBe("consolidate");
      expect(burst.message).toMatch(/trail/);
      expect(burst.message).toMatch(/supersede|one entry|unifying|consolidat/i);
      // The old sequence congratulated every burst; that is the trained
      // behaviour this generator exists to stop.
      expect(burst.message).not.toMatch(/well heccn done|breakthrough|nice work/i);
    }
    // The shift also debugged its proof in the corpus ("Repair: …",
    // "Second repair: …"); once that chain is visible the steer names it.
    expect(checkins.some((checkin) => /repair of a repair|bench/.test(checkin.message))).toBe(
      true,
    );
  });

  it("lets the opus deep-work shift keep going, operator's opener verbatim first", () => {
    const checkins = replay("frontier-opus-deep.jsonl", "math-frontier");
    // Peak 4 filings in a turn across four hours on one named conjecture:
    // never worth steering.
    expect(checkins.every((checkin) => checkin.cls !== "consolidate")).toBe(true);
    expect(checkins[0]?.message).toContain("take a step back");
    expect(checkins[0]?.message).toContain("attack guide on the MCP");
    // The last real check-in landed at 94% of the budget: ask for landing,
    // not for a new front.
    const last = checkins[checkins.length - 1];
    expect(last?.cls).toBe("late");
    expect(last?.message).toMatch(/land|bank|report/i);
  });

  it("never steers the review shift, whose whole job is bulk verdicts", () => {
    const checkins = replay("review-opus.jsonl", "math-review");
    expect(checkins.length).toBeGreaterThan(20);
    expect(checkins.every((checkin) => checkin.cls !== "consolidate")).toBe(true);
    for (let i = 1; i < checkins.length; i++) {
      expect(checkins[i]?.message).not.toBe(checkins[i - 1]?.message);
    }
  });

  it("never steers cleanup's mass corpus repair, however many entries it files", () => {
    const checkins = replay("cleanup-sol-batch.jsonl", "math-cleanup");
    const heaviest = Math.max(...checkins.map((checkin) => checkin.latest.submissions.length));
    expect(heaviest).toBeGreaterThanOrEqual(20); // the fixture really is bulk work
    expect(checkins.every((checkin) => checkin.cls !== "consolidate")).toBe(true);
  });

  it("catches the slow census walker by its titles, where volume thresholds miss it", () => {
    // 3 filings per turn stays under every count threshold, but "…through
    // order seventeen" → "…at order eighteen" is the same rung count in a
    // different font. The operator aborted the real run by hand; the
    // generator should be the one to say it now.
    const checkins = replay("frontier-census-walk.jsonl", "math-frontier");
    expect(checkins.length).toBeGreaterThanOrEqual(1);
    expect(checkins.some((checkin) => checkin.cls === "consolidate")).toBe(true);
    expect(checkins.every((checkin) => checkin.latest.submissions.length < 5)).toBe(true);
  });

  it("gives the empty-queue shift honest permission to rest instead of re-goading it", () => {
    const checkins = replay("pr-sol-empty-queue.jsonl", "fast-math-pr");
    // The real agent re-polled an empty queue and reported productive=false.
    const afterEmpty = checkins.filter((checkin) => checkin.latest.reportedUnproductive);
    expect(afterEmpty.length).toBeGreaterThanOrEqual(1);
    for (const checkin of afterEmpty) {
      expect(checkin.cls).toBe("quiet");
      expect(checkin.message).toMatch(/plainly|rest/);
    }
  });

  it("stays warm in every message, whatever it has to say", () => {
    const shifts: [string, string][] = [
      ["frontier-sol-ladder.jsonl", "math-frontier"],
      ["frontier-opus-deep.jsonl", "math-frontier"],
      ["review-opus.jsonl", "math-review"],
      ["cleanup-sol-batch.jsonl", "math-cleanup"],
      ["pr-sol-empty-queue.jsonl", "fast-math-pr"],
      ["frontier-census-walk.jsonl", "math-frontier"],
    ];
    for (const [fixture, taskId] of shifts) {
      for (const checkin of replay(fixture, taskId)) {
        // Not terse (kindness is load-bearing; a clipped message reads cold
        // regardless of intent) and explicitly warm.
        expect(checkin.message.length).toBeGreaterThanOrEqual(150);
        expect(checkin.message).toMatch(WARM);
      }
    }
  });
});

describe("check-in generation", () => {
  const turn = (facts: Partial<TurnFacts>): TurnFacts => ({
    toolCalls: 0,
    submissions: [],
    reported: false,
    reportedUnproductive: false,
    ...facts,
  });
  const view = (taskId: string, turns: TurnFacts[], overrides: Partial<ShiftView> = {}): ShiftView => ({
    taskId,
    turn: turns.length,
    elapsedMs: 60_000 * turns.length,
    budgetMs: SESSION_BUDGET_MS,
    turns,
    ...overrides,
  });
  const submissions = (count: number): { title: string }[] =>
    Array.from({ length: count }, (_, i) => ({ title: `entry ${i}` }));

  it("advances through variants instead of repeating itself when a condition persists", () => {
    const burst = () => turn({ toolCalls: 30, submissions: submissions(8) });
    const first = continuationFor(view("math-frontier", [burst()]));
    const second = continuationFor(view("math-frontier", [burst(), burst()]));
    expect(first).not.toBe(second);

    const working = () => turn({ toolCalls: 20, reported: true });
    const flows = [1, 2, 3].map((count) =>
      continuationFor(view("math-frontier", Array.from({ length: count }, working))),
    );
    expect(new Set(flows).size).toBe(3);
  });

  it("treats an unproductive report as a quiet turn even when tools ran", () => {
    const polled = turn({ toolCalls: 5, reported: true, reportedUnproductive: true });
    expect(shiftClass(view("fast-math-pr", [polled]))).toBe("quiet");
  });
});
