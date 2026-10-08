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
    hasAttribute: () => false,
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

test("a reader's viewport stays put as live text grows", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
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

test("CSS scroll-anchor support does not disable compensation for replaced or virtualized content", () => {
  const prior = globalThis.CSS;
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: { supports: () => true } });
  try {
    const page = fixture();
    const reading = new ReadingAnchor();
    reading.setReading(page.scroller, true);
    page.growBelow(300);
    reading.afterResize(page.scroller);
    expect(page.scroller.scrollTop).toBe(-420);
  } finally {
    if (prior === undefined) Reflect.deleteProperty(globalThis, "CSS");
    else Object.defineProperty(globalThis, "CSS", { configurable: true, value: prior });
  }
});

test("a replaced message is recovered by identity even when total height changes above it", () => {
  let scrollTop = -300;
  let height = 1200;
  let replaced = false;
  let y = 40;
  const makeAnchor = () => ({
    closest() { return this; },
    hasAttribute: (name: string) => name === "data-message-id",
    getAttribute: () => "held-message",
    getBoundingClientRect: () => ({ top: y - scrollTop }),
  });
  const original = makeAnchor(), replacement = makeAnchor();
  const scroller = {
    get scrollTop() { return scrollTop; }, set scrollTop(value: number) { scrollTop = value; },
    get scrollHeight() { return height; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    ownerDocument: { elementFromPoint: () => replaced ? replacement : original },
    contains: (node: unknown) => node === (replaced ? replacement : original),
    querySelectorAll: () => [replacement],
  } as unknown as HTMLElement;
  const reading = new ReadingAnchor();
  reading.setReading(scroller, true);
  const before = reading.beforeUpdate(scroller);
  replaced = true;
  height += 200;
  reading.afterUpdate(scroller, before);
  expect(scrollTop).toBe(-300);
  y -= 80;
  reading.afterResize(scroller);
  expect(scrollTop).toBe(-380);
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
