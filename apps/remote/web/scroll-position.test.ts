import { expect, test } from "bun:test";
import { isReadingEarlier, ReadingAnchor, restoreReadingPosition } from "./src/scroll-position";

test("scrolling even slightly above latest pauses following, but iOS bottom overscroll does not", () => {
  expect(isReadingEarlier(0)).toBe(false);
  expect(isReadingEarlier(-1)).toBe(false);
  expect(isReadingEarlier(-3)).toBe(true);
  expect(isReadingEarlier(20)).toBe(false);
});

function fixture() {
  let height = 1200;
  let anchorTop = -140;
  let present = true;
  const anchor = {
    closest: () => anchor,
    getBoundingClientRect: () => ({ top: anchorTop - scroller.scrollTop }),
  };
  const scroller = {
    scrollTop: -120,
    get scrollHeight() { return height; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    ownerDocument: { elementFromPoint: () => present ? anchor : null },
    contains: (element: unknown) => present && element === anchor,
  } as unknown as HTMLDivElement;
  return {
    scroller,
    growBelow(amount: number) { height += amount; anchorTop -= amount; },
    prependAbove(amount: number) { height += amount; },
    replaceLive(heightChange: number) { height += heightChange; present = false; },
  };
}

test("a reader's viewport stays put as live text grows without native scroll anchoring", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  expect(reading.needsFallback).toBe(true);
  reading.setReading(page.scroller, true);
  page.growBelow(300);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(-420);

  page.prependAbove(200);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(-420);
});

test("completion preserves the reading offset when the live anchor is replaced", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, true);
  const beforeCommit = reading.beforeUpdate(page.scroller);
  page.replaceLive(-20);
  reading.afterUpdate(page.scroller, beforeCommit);
  expect(page.scroller.scrollTop).toBe(-100);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(-100);
});

test("following latest leaves scroll position to reverse flex layout", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, false);
  page.growBelow(300);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(-120);
});

test("compensation does not double-apply a browser's own scroll adjustment", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, true);
  const before = reading.beforeUpdate(page.scroller)!;
  page.growBelow(300);
  page.scroller.scrollTop = -420;
  restoreReadingPosition(page.scroller, before);
  expect(page.scroller.scrollTop).toBe(-420);
});
