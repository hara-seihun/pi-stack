import { expect, test } from "bun:test";
import { isReadingEarlier, ReadingAnchor } from "./src/scroll-position";

function fixture() {
  let height = 1200;
  let anchorTop = 540;
  let present = true;
  let top = 500;
  let writes = 0;
  const anchor = {
    closest: () => anchor,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ top: anchorTop - scroller.scrollTop }),
  };
  const scroller = {
    style: { overflowAnchor: "none" },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = value; writes++; },
    clientHeight: 200,
    get scrollHeight() { return height; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    ownerDocument: { elementFromPoint: () => present ? anchor : null },
    contains: (element: unknown) => present && element === anchor,
  } as unknown as HTMLDivElement;
  return {
    scroller,
    writes: () => writes,
    move(value: number) { top = value; },
    growBelow(amount: number) { height += amount; },
    prependAbove(amount: number) { height += amount; anchorTop += amount; },
    replaceLive(heightChange: number) { height += heightChange; present = false; },
  };
}

test("normal-flow bottom detection tolerates rounding and bottom overscroll", () => {
  expect(isReadingEarlier(1000, 1200, 200)).toBe(false);
  expect(isReadingEarlier(999, 1200, 200)).toBe(false);
  expect(isReadingEarlier(997, 1200, 200)).toBe(true);
  expect(isReadingEarlier(1020, 1200, 200)).toBe(false);
});

test("reading above latest follows an identified row, not total content height", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, true);
  page.growBelow(300);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(500);
  expect(page.writes()).toBe(0);
  page.prependAbove(200);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(700);
  expect(page.writes()).toBe(1);
});

test("resize and commit delivery yield to compositor movement before its scroll event", () => {
  for (const delivery of ["resize", "commit"]) {
    const page = fixture();
    const reading = new ReadingAnchor();
    reading.setReading(page.scroller, true);
    const before = reading.beforeUpdate(page.scroller);
    page.move(240);
    page.prependAbove(200);
    if (delivery === "resize") reading.afterResize(page.scroller);
    else reading.afterUpdate(page.scroller, before);
    expect(page.scroller.scrollTop).toBe(240);
    expect(page.writes()).toBe(0);
    page.prependAbove(80);
    reading.afterResize(page.scroller);
    expect(page.scroller.scrollTop).toBe(320);
  }
});

test("a removed anchor never guesses a correction from total height", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, true);
  const before = reading.beforeUpdate(page.scroller);
  page.replaceLive(-20);
  reading.afterUpdate(page.scroller, before);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(500);
  expect(page.writes()).toBe(0);
});

test("a layout clamp at bottom does not turn a reading viewport into a following viewport", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, true);
  const before = reading.beforeUpdate(page.scroller);
  page.replaceLive(-800);
  page.move(200);
  reading.afterUpdate(page.scroller, before);
  expect(reading.onScroll(page.scroller)).toEqual({ reading: true, programmatic: true });
  page.growBelow(1000);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(200);
  expect(page.writes()).toBe(0);
});

test("wheel, drag, touch and momentum ownership prevents every programmatic scroll", () => {
  for (const atLatest of [false, true]) {
    const page = fixture();
    if (atLatest) page.move(1000);
    const reading = new ReadingAnchor();
    reading.setReading(page.scroller, !atLatest);
    reading.beginInteraction(page.scroller);
    const before = reading.beforeUpdate(page.scroller);
    page.prependAbove(200);
    page.growBelow(300);
    reading.afterUpdate(page.scroller, before);
    reading.afterResize(page.scroller);
    expect(page.writes()).toBe(0);
    expect(page.scroller.style.overflowAnchor).toBe("auto");
    page.move(400);
    reading.onScroll(page.scroller);
    page.prependAbove(80);
    reading.afterResize(page.scroller);
    expect(page.writes()).toBe(0);
    reading.endInteraction(page.scroller);
    reading.afterResize(page.scroller);
    expect(page.writes()).toBe(0);
    expect(page.scroller.scrollTop).toBe(400);
    expect(page.scroller.style.overflowAnchor).toBe("none");
    page.prependAbove(60);
    reading.afterResize(page.scroller);
    expect(page.scroller.scrollTop).toBe(460);
  }
});

test("suspending a pane releases contact ownership without losing its reading mode", () => {
  const page = fixture();
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, true);
  reading.beginInteraction(page.scroller);
  reading.pause(page.scroller);
  reading.afterResize(page.scroller);
  page.prependAbove(80);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(580);
  expect(page.scroller.style.overflowAnchor).toBe("none");
});

test("following latest writes only at idle and owned scroll events keep following enabled", () => {
  const page = fixture();
  page.move(1000);
  const reading = new ReadingAnchor();
  reading.setReading(page.scroller, false);
  page.growBelow(300);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(1300);
  expect(reading.onScroll(page.scroller)).toEqual({ reading: false, programmatic: true });
  page.growBelow(80);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(1380);
  reading.onScroll(page.scroller);
  reading.beginInteraction(page.scroller);
  page.move(700);
  expect(reading.onScroll(page.scroller)).toEqual({ reading: true, programmatic: false });
  page.growBelow(500);
  reading.afterResize(page.scroller);
  expect(page.scroller.scrollTop).toBe(700);
  reading.endInteraction(page.scroller);
  reading.jumpLatest(page.scroller);
  expect(page.scroller.scrollTop).toBe(1880);
});

test("replacement DOM is reacquired by message identity; browser anchoring is not double-applied", () => {
  let top = 300;
  let replaced = false;
  let y = 340;
  const makeAnchor = () => ({
    closest() { return this; },
    hasAttribute: (name: string) => name === "data-message-id",
    getAttribute: () => "held-message",
    getBoundingClientRect: () => ({ top: y - top }),
  });
  const original = makeAnchor(), replacement = makeAnchor();
  const scroller = {
    get scrollTop() { return top; }, set scrollTop(value: number) { top = value; },
    clientHeight: 200, scrollHeight: 1200,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    ownerDocument: { elementFromPoint: () => replaced ? replacement : original },
    contains: (node: unknown) => node === (replaced ? replacement : original),
    querySelectorAll: () => [replacement],
  } as unknown as HTMLElement;
  const reading = new ReadingAnchor();
  reading.setReading(scroller, true);
  const before = reading.beforeUpdate(scroller);
  replaced = true;
  y += 200;
  reading.afterUpdate(scroller, before);
  expect(top).toBe(500);
  y += 80;
  top += 80;
  reading.afterResize(scroller);
  expect(top).toBe(580);
});
